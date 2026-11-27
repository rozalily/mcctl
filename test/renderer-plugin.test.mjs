import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncRendererPlugin } from "../bridge/renderer-plugin.mjs";

test("atomically refreshes the per-instance renderer plugin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-renderer-"));
  const renderer = path.join(root, "renderer.jar");
  const instance = path.join(root, "instance");
  try {
    await writeFile(renderer, "first");
    const target = await syncRendererPlugin(instance, renderer);
    assert.equal(await readFile(target, "utf8"), "first");
    assert.equal((await stat(target)).mode & 0o777, 0o644);

    await writeFile(renderer, "second");
    await syncRendererPlugin(instance, renderer);
    assert.equal(await readFile(target, "utf8"), "second");
    assert.deepEqual((await readdir(path.dirname(target))).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});