import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { manifestRootFor } from "../lib/instances.mjs";
import { formatInstanceList, formatInstanceStatus, parseArguments } from "../mcctl.mjs";

test("boolean options do not consume following positional arguments", () => {
  const parsed = parseArguments(["--accept-eula", "server", "latest-fabric", "--yes"]);
  assert.deepEqual(parsed.positional, ["server", "latest-fabric"]);
  assert.equal(parsed.has("accept-eula"), true);
  assert.equal(parsed.has("yes"), true);
});

test("parses repeated and equals-form options", () => {
  const parsed = parseArguments(["server", "--launch=./start.sh", "--arg", "nogui", "--arg=--safe"]);
  assert.deepEqual(parsed.positional, ["server"]);
  assert.equal(parsed.get("launch"), "./start.sh");
  assert.deepEqual(parsed.all("arg"), ["nogui", "--safe"]);
});

test("rejects missing option values and valued boolean flags", () => {
  assert.throws(() => parseArguments(["server", "--port"]), /requires a value/);
  assert.throws(() => parseArguments(["server", "--yes=false"]), /does not accept a value/);
});

test("formats concise running and failed instance status", () => {
  assert.equal(
    formatInstanceStatus({
      name: "demo",
      manifest: { state: "adopted", port: 25565, memory: "4G", requestedSpec: null },
      systemd: {
        ActiveState: "active",
        SubState: "running",
        UnitFileState: "enabled",
        ActiveEnterTimestampMonotonic: "1000000",
        MemoryCurrent: "1610612736",
        MemoryPeak: "2147483648",
        CPUUsageNSec: "3900000000000",
        NRestarts: "0",
      },
      portDetail: "listening on 25565",
      playerCount: { online: 2, max: 20 },
      nowMonotonicUs: 91_000_000,
    }),
    [
      "demo",
      "  State     running",
      "  Service   enabled · minecraft@demo.service",
      "  Port      25565 · listening",
      "  Players   2/20",
      "  Uptime    1m 30s",
      "  Memory    1.5 GiB current · 2 GiB peak · 4G configured",
      "  CPU time  1h 5m",
      "  Console   mcctl console demo",
    ].join("\n"),
  );

  assert.match(
    formatInstanceStatus({
      name: "stopped",
      manifest: { state: "installed", port: 25566, requestedSpec: "1.21.1-fabric" },
      systemd: {
        ActiveState: "failed",
        SubState: "failed",
        UnitFileState: "enabled",
        ExecMainStatus: "143",
        StateChangeTimestampMonotonic: "1000000",
        NRestarts: "2",
      },
      portDetail: "25566 available",
      playerCount: null,
      nowMonotonicUs: 3_601_000_000,
    }),
    /State\s+failed \(exit 143\)[\s\S]*Port\s+25566 · available[\s\S]*Stopped\s+1h ago[\s\S]*Restarts\s+2[\s\S]*Spec\s+1\.21\.1-fabric/,
  );
});

test("formats an operational instance inventory", () => {
  const output = formatInstanceList([
    {
      name: "mayview",
      state: "stopped",
      players: "-",
      version: "1.21.1",
      port: 31215,
      memory: "-/8G",
      uptime: "-",
      boot: "yes",
    },
    {
      name: "mong",
      state: "running",
      players: "2/24",
      version: "Beta 1.7.3",
      port: 25565,
      memory: "1.7GiB/4G",
      uptime: "5m 4s",
      boot: "yes",
    },
  ]);
  assert.match(output, /^NAME\s+STATE\s+PLAYERS\s+VERSION\s+PORT\s+MEMORY\s+UPTIME\s+BOOT$/m);
  assert.match(output, /^mong\s+running\s+2\/24\s+Beta 1\.7\.3\s+25565\s+1\.7GiB\/4G\s+5m 4s\s+yes$/m);
  assert.doesNotMatch(output, /SERVICE|MCCTL|adopted/);
});

test("lists and operates on managed instances only", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-managed-only-"));
  try {
    await mkdir(path.join(root, "managed"));
    await mkdir(path.join(root, "external"));
    await mkdir(manifestRootFor(root));
    await writeFile(
      path.join(manifestRootFor(root), "managed.json"),
      `${JSON.stringify({ state: "adopted", requestedSpec: null })}\n`,
    );

    const environment = { ...process.env, MCCTL_ROOT: root };
    const listed = spawnSync(process.execPath, [path.resolve("mcctl.mjs"), "list"], { encoding: "utf8", env: environment });
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /^NAME\s+STATE\s+PLAYERS\s+VERSION\s+PORT\s+MEMORY\s+UPTIME\s+BOOT$/m);
    assert.match(listed.stdout, /^managed\s+stopped\s+/m);
    assert.doesNotMatch(listed.stdout, /^external\s+/m);

    const status = spawnSync(process.execPath, [path.resolve("mcctl.mjs"), "status", "external"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(status.status, 1);
    assert.match(status.stderr, /external\.json/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configures and toggles an instance bridge without printing its token", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-bridge-cli-"));
  const tokenFile = path.join(root, "discord.token");
  const token = "test-token-not-a-real-discord-credential";
  try {
    await mkdir(path.join(root, "demo"));
    await mkdir(manifestRootFor(root));
    await writeFile(path.join(manifestRootFor(root), "demo.json"), `${JSON.stringify({ state: "adopted" })}\n`);
    await writeFile(tokenFile, `${token}\n`);
    const environment = { ...process.env, MCCTL_ROOT: root };
    const enabled = spawnSync(
      process.execPath,
      [
        path.resolve("mcctl.mjs"),
        "bridge",
        "demo",
        "--enable",
        "--channel",
        "123456789",
        "--token-file",
        tokenFile,
        "--command-style",
        "broadcast",
        "--no-announce",
      ],
      { encoding: "utf8", env: environment },
    );
    assert.equal(enabled.status, 0, enabled.stderr);
    assert.match(enabled.stdout, /Enabled\s+yes/);
    assert.match(enabled.stdout, /Command\s+broadcast/);
    assert.doesNotMatch(enabled.stdout, new RegExp(token.replaceAll(".", "\\.")));
    const bridgeRoot = path.join(root, ".mcctl-bridges");
    assert.equal((await stat(path.join(bridgeRoot, "demo.token"))).mode & 0o777, 0o640);
    assert.equal((await readFile(path.join(bridgeRoot, "demo.token"), "utf8")).trim(), token);
    assert.deepEqual(
      await readFile(path.join(root, "demo", "plugins", "McctlBridgeRenderer.jar")),
      await readFile(path.resolve("bridge/renderer/mcctl-bridge-renderer.jar")),
    );

    const disabled = spawnSync(process.execPath, [path.resolve("mcctl.mjs"), "bridge", "demo", "--disable", "--command-style", "say"], {
      encoding: "utf8",
      env: environment,
    });
    assert.equal(disabled.status, 0, disabled.stderr);
    assert.match(disabled.stdout, /Enabled\s+no/);
    await assert.rejects(readFile(path.join(root, "demo", "plugins", "McctlBridgeRenderer.jar")), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
