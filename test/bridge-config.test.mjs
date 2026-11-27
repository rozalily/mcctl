import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { bridgePaths, configureBridge, readBridgeStatus } from "../lib/bridge-config.mjs";

test("configures, enables, updates, and disables an instance bridge", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-bridge-"));
  const tokenFile = path.join(root, "input.token");
  try {
    assert.deepEqual(await readBridgeStatus("demo", root), {
      enabled: false,
      tokenConfigured: false,
      config: null,
    });
    await assert.rejects(
      configureBridge({ name: "demo", bridgeRoot: root, enabled: true, channelId: "123", commandStyle: "say" }),
      /token-file/,
    );
    await writeFile(tokenFile, "test-token-not-a-real-discord-credential\n");
    let status = await configureBridge({
      name: "demo",
      bridgeRoot: root,
      enabled: true,
      channelId: "123",
      tokenFile,
      commandStyle: "broadcast",
      announceLifecycle: false,
    });
    assert.equal(status.enabled, true);
    assert.equal(status.tokenConfigured, true);
    assert.deepEqual(status.config, {
      version: 1,
      instance: "demo",
      channelId: "123",
      commandStyle: "broadcast",
      announceLifecycle: false,
    });
    assert.equal((await stat(bridgePaths("demo", root).token)).mode & 0o777, 0o640);
    assert.equal((await readFile(bridgePaths("demo", root).token, "utf8")).trim(), "test-token-not-a-real-discord-credential");

    status = await configureBridge({ name: "demo", bridgeRoot: root, enabled: false, commandStyle: "tellraw" });
    assert.equal(status.enabled, false);
    assert.equal(status.tokenConfigured, true);
    assert.equal(status.config.commandStyle, "tellraw");
    await assert.rejects(
      configureBridge({ name: "bad", bridgeRoot: root, channelId: "not-a-channel" }),
      /numeric/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
