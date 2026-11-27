import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RENDERER = fileURLToPath(new URL("./renderer/mcctl-bridge-renderer.jar", import.meta.url));

export async function syncRendererPlugin(instanceDirectory, renderer = DEFAULT_RENDERER) {
  const plugins = path.join(instanceDirectory, "plugins");
  const target = path.join(plugins, "McctlBridgeRenderer.jar");
  const temporary = path.join(plugins, `.McctlBridgeRenderer.${randomUUID()}.tmp`);
  await fs.mkdir(plugins, { recursive: true, mode: 0o750 });
  try {
    await fs.copyFile(renderer, temporary);
    await fs.chmod(temporary, 0o644);
    const handle = await fs.open(temporary, "r");
    await handle.sync();
    await handle.close();
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
  return target;
}