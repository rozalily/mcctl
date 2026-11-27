import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { queryPlayerCount, readLegacyPlayerCount, readLoggedVersion } from "../lib/minecraft-status.mjs";

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

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("queries modern player counts", async () => {
  const json = Buffer.from(JSON.stringify({ version: { name: "1.21.1" }, players: { online: 2, max: 20 } }));
  const body = Buffer.concat([Buffer.from([0x00]), encodeVarInt(json.length), json]);
  const packet = Buffer.concat([encodeVarInt(body.length), body]);
  const server = net.createServer((socket) => socket.once("data", () => socket.end(packet)));
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await queryPlayerCount(address.port);
    assert.equal(result.online, 2);
    assert.equal(result.max, 20);
    assert.equal(result.version, "1.21.1");
    assert.equal(Number.isInteger(result.latencyMs), true);
  } finally {
    await close(server);
  }
});

test("falls back to legacy player counts", async () => {
  const text = "Beta server§3§24";
  const encoded = Buffer.from(text, "utf16le");
  encoded.swap16();
  const header = Buffer.alloc(3);
  header[0] = 0xff;
  header.writeUInt16BE(text.length, 1);
  const packet = Buffer.concat([header, encoded]);
  const server = net.createServer((socket) =>
    socket.once("data", (request) => {
      if (request[0] === 0xfe) socket.end(packet);
      else socket.end();
    }),
  );
  await listen(server);
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const result = await queryPlayerCount(address.port);
    assert.equal(result.online, 3);
    assert.equal(result.max, 24);
    assert.equal(result.version, null);
    assert.equal(Number.isInteger(result.latencyMs), true);
  } finally {
    await close(server);
  }
});

test("reconstructs Beta player counts from bounded log snapshots", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcctl-legacy-count-"));
  const log = path.join(directory, "server.log");
  try {
    await writeFile(
      log,
      [
        "2026-11-25 10:00:00 [INFO] Connected players: Alpha, Beta§f",
        "2026-11-25 10:00:01 [INFO] Alpha has left the game.",
        "2026-11-25 10:00:02 [INFO] Gamma [/127.0.0.1:1234] logged in with entity id 3 at ([world] 0, 0, 0)",
        "",
      ].join("\n"),
    );
    assert.deepEqual(await readLegacyPlayerCount(log, 24), { online: 2, max: 24, version: null });
    assert.deepEqual(await queryPlayerCount(1, { legacyLogPath: log, maxPlayers: 24 }), {
      online: 2,
      max: 24,
      version: null,
      latencyMs: 0,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("finds old server versions from a bounded log head", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcctl-log-version-"));
  const log = path.join(directory, "server.log");
  try {
    await writeFile(log, `Starting minecraft server version Beta 1.7.3\n${"x".repeat(2 * 1024 * 1024 + 1)}`);
    assert.equal(await readLoggedVersion(log), "Beta 1.7.3");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
