import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverServers,
  isValidInstanceId,
  parseLogLine,
  parseProperties,
  queryMinecraftStatus,
  readRecentActivity,
  readLegacyPlayerState,
} from "../lib/dashboard.mjs";

test("discovers managed services and infers legacy log handling", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "minecraft-discovery-"));
  const manifestRoot = path.join(root, "manifests");
  try {
    await mkdir(manifestRoot);
    for (const name of ["modern", "legacy"]) {
      await mkdir(path.join(root, name));
      await writeFile(path.join(root, name, "server.properties"), `server-port=${name === "modern" ? 25565 : 25566}\n`);
      await writeFile(path.join(manifestRoot, `${name}.json`), `${JSON.stringify({ state: "adopted" })}\n`);
    }
    await mkdir(path.join(root, "modern", "logs"));
    await writeFile(path.join(root, "modern", "logs", "latest.log"), "");
    await writeFile(path.join(root, "legacy", "server.log"), "");
    await mkdir(path.join(root, "external"));
    await writeFile(path.join(root, "external", "server.properties"), "server-port=25567\n");
    await mkdir(path.join(root, "malformed"));
    await writeFile(path.join(root, "malformed", "server.properties"), "server-port=25568\n");
    await writeFile(path.join(manifestRoot, "malformed.json"), "{\n");

    const servers = await discoverServers(root, { manifestRoot });
    assert.deepEqual(
      servers.map(({ id, service, legacyPing }) => ({ id, service, legacyPing })),
      [
        { id: "legacy", service: "minecraft@legacy.service", legacyPing: true },
        { id: "modern", service: "minecraft@modern.service", legacyPing: false },
      ],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function encodeVarInt(value) {
  const bytes = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

test("parses Java server properties", () => {
  const properties = parseProperties("# comment\nserver-port=31215\nmotd=Modern\\u0020Server\\nOnline\n");
  assert.deepEqual(properties, {
    "server-port": "31215",
    motd: "Modern Server\nOnline",
  });
});

test("parses modern and legacy chat without markup interpretation", () => {
  const modern = parseLogLine(
    "modern",
    "[13Nov2026 19:58:06.474] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: <Player_1> <b>hello</b>",
  );
  assert.equal(modern?.type, "chat");
  assert.equal(modern?.player, "Player_1");
  assert.equal(modern?.message, "<b>hello</b>");

  const legacy = parseLogLine("legacy", "2026-11-13 18:02:17 [INFO] Player_2 has left the game.");
  assert.equal(legacy?.type, "leave");
  assert.equal(legacy?.player, "Player_2");

  const formattedLegacy = parseLogLine(
    "legacy",
    "2026-11-13 18:40:47 [INFO] <beaniao\u001b[37m> hello §aworld\u001b[0m",
  );
  assert.equal(formattedLegacy?.player, "beaniao");
  assert.equal(formattedLegacy?.message, "hello world");
});

test("reconstructs and incrementally updates legacy player state", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraft-dashboard-"));
  const filename = path.join(directory, "server.log");
  try {
    await writeFile(
      filename,
      [
        "2026-11-13 10:00:00 [INFO] Starting minecraft server version Beta 1.7.3",
        "2026-11-13 10:01:00 [INFO] Alpha [/127.0.0.1:1000] logged in with entity id 1 at ([world] 0, 0, 0)",
        "2026-11-13 10:02:00 [INFO] Beta [/127.0.0.1:1001] logged in with entity id 2 at ([world] 0, 0, 0)",
        "2026-11-13 10:03:00 [INFO] Alpha has left the game.",
        "2026-11-13 10:03:30 [INFO] Connected players: Beta\u001b[37m\u001b[0m",
        "",
      ].join("\n"),
    );

    assert.deepEqual(await readLegacyPlayerState(filename), {
      players: ["Beta"],
      version: "Beta 1.7.3",
    });

    await appendFile(filename, "2026-11-13 10:04:00 [INFO] Beta lost connection\n");
    assert.deepEqual((await readLegacyPlayerState(filename)).players, []);

    await appendFile(
      filename,
      "2026-11-13 10:05:00 [INFO] Stale [/127.0.0.1:1003] logged in with entity id 4 at ([world] 0, 0, 0)\n" +
        "2026-11-13 10:05:01 [INFO] Connected players: Gamma\n",
    );
    assert.deepEqual((await readLegacyPlayerState(filename)).players, ["Gamma"]);

    await appendFile(
      filename,
      "2026-11-13 11:00:00 [INFO] Starting minecraft server version Beta 1.7.4\n" +
        "2026-11-13 11:01:00 [INFO] Gamma [/127.0.0.1:1002] logged in with entity id 3 at ([world] 0, 0, 0)\n",
    );
    assert.deepEqual(await readLegacyPlayerState(filename), {
      players: ["Gamma"],
      version: "Beta 1.7.4",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reports successful legacy joins but ignores bad-packet handshakes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraft-activity-"));
  const filename = path.join(directory, "server.log");
  try {
    await writeFile(
      filename,
      [
        "2026-11-13 10:00:00 [INFO] Alpha [/127.0.0.1:1000] logged in with entity id 1 at ([world] 0, 0, 0)",
        "2026-11-13 10:00:02 [INFO] <Alpha\\u001b[37m> hello\\u001b[0m",
        "2026-11-13 10:01:00 [INFO] Gray [/127.0.0.1:1001] logged in with entity id 2 at ([world] 0, 0, 0)",
        "2026-11-13 10:01:00 [INFO] Bad packet id: 110",
        "2026-11-13 10:02:00 [INFO] Alpha has left the game.",
        "",
      ].join("\n").replaceAll("\\u001b", "\u001b"),
    );
    const activity = await readRecentActivity({ id: "legacy", logPath: filename, legacyPing: true });
    assert.deepEqual(
      activity.map(({ type, player, message }) => ({ type, player, message })),
      [
        { type: "join", player: "Alpha", message: "joined the game" },
        { type: "chat", player: "Alpha", message: "hello" },
        { type: "leave", player: "Alpha", message: "left the game" },
      ],
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("queries a modern Minecraft status endpoint", async () => {
  const status = {
    version: { name: "1.21.1", protocol: 767 },
    players: { online: 2, max: 20, sample: [{ name: "Alpha" }, { name: "Beta" }] },
    description: { text: "Modern", extra: [{ text: " online" }] },
  };
  const json = Buffer.from(JSON.stringify(status));
  const body = Buffer.concat([Buffer.from([0x00]), encodeVarInt(json.length), json]);
  const packet = Buffer.concat([encodeVarInt(body.length), body]);
  const fakeServer = net.createServer((socket) => socket.once("data", () => socket.end(packet)));
  await new Promise((resolve) => fakeServer.listen(0, "127.0.0.1", resolve));

  try {
    const address = fakeServer.address();
    assert.equal(typeof address, "object");
    const result = await queryMinecraftStatus(address.port);
    assert.equal(result.online, true);
    assert.equal(result.version, "1.21.1");
    assert.equal(result.playersOnline, 2);
    assert.deepEqual(result.players, ["Alpha", "Beta"]);
    assert.equal(result.motd, "Modern online");
  } finally {
    await new Promise((resolve) => fakeServer.close(resolve));
  }
});

test("validates instance identifiers", () => {
  assert.equal(isValidInstanceId("modern"), true);
  assert.equal(isValidInstanceId("server-2"), true);
  assert.equal(isValidInstanceId("../world"), false);
  assert.equal(isValidInstanceId("Bad Name"), false);
});
