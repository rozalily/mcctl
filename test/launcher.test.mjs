import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const launcher = path.resolve("minecraft-launch");

async function executable(filename, content) {
  await writeFile(filename, content);
  await chmod(filename, 0o755);
}

test("launches instances directly or through their enabled bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-launcher-"));
  const serverRoot = path.join(root, "servers");
  const bridgeRoot = path.join(root, "bridges");
  const runtime = path.join(root, "runtime");
  const runRoot = path.join(root, "run");
  const marker = path.join(root, "launched");
  try {
    await mkdir(path.join(serverRoot, "demo"), { recursive: true });
    await mkdir(bridgeRoot);
    await mkdir(path.join(runtime, "bridge"), { recursive: true });
    await mkdir(path.join(runRoot, "minecraft-demo"), { recursive: true });
    await executable(path.join(serverRoot, "demo", "run"), '#!/bin/sh\nprintf direct > "$MARKER"\n');
    await executable(path.join(runtime, "node"), '#!/bin/sh\nprintf bridge > "$MARKER"\n');
    await writeFile(path.join(runtime, "bridge", "launch.mjs"), "");
    const environment = {
      ...process.env,
      MARKER: marker,
      MCCTL_ROOT: serverRoot,
      MCCTL_BRIDGE_ROOT: bridgeRoot,
      MCCTL_RUNTIME_DIR: runtime,
      MCCTL_RUN_ROOT: runRoot,
    };

    let result = spawnSync("bash", [launcher, "demo"], { encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(marker, "utf8"), "direct");
    assert.equal(await readFile(path.join(runRoot, "minecraft-demo", "server-exit-status"), "utf8"), "0\n");

    await writeFile(path.join(bridgeRoot, "demo.enabled"), "enabled\n");
    result = spawnSync("bash", [launcher, "demo"], { encoding: "utf8", env: environment });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(marker, "utf8"), "bridge");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
