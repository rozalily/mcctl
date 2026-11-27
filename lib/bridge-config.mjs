import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { validateInstanceName } from "./instances.mjs";

const DEFAULT_INSTANCE_ROOT = "/srv/minecraft";
export const DEFAULT_BRIDGE_ROOT = "/etc/mcctl/bridges";

export function bridgeRootFor(instanceRoot) {
  return path.resolve(instanceRoot) === DEFAULT_INSTANCE_ROOT ? DEFAULT_BRIDGE_ROOT : path.join(instanceRoot, ".mcctl-bridges");
}

export function bridgePaths(name, bridgeRoot = DEFAULT_BRIDGE_ROOT) {
  validateInstanceName(name);
  return {
    config: path.join(bridgeRoot, `${name}.json`),
    token: path.join(bridgeRoot, `${name}.token`),
    enabled: path.join(bridgeRoot, `${name}.enabled`),
  };
}

async function exists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function writeAtomic(filename, content, mode) {
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filename);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}

function validateConfig(config) {
  if (!/^\d+$/.test(config.channelId || "")) throw new Error("Discord channel ID must be numeric.");
  if (!["tellraw", "say", "broadcast"].includes(config.commandStyle)) {
    throw new Error("Bridge command style must be tellraw, say, or broadcast.");
  }
  if (typeof config.announceLifecycle !== "boolean") throw new Error("Bridge announceLifecycle must be boolean.");
  return config;
}

export async function readBridgeStatus(name, bridgeRoot = DEFAULT_BRIDGE_ROOT) {
  const paths = bridgePaths(name, bridgeRoot);
  let config = null;
  try {
    config = validateConfig(JSON.parse(await fs.readFile(paths.config, "utf8")));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    enabled: await exists(paths.enabled),
    tokenConfigured: await exists(paths.token),
    config,
  };
}

export async function configureBridge({
  name,
  bridgeRoot = DEFAULT_BRIDGE_ROOT,
  enabled,
  channelId,
  tokenFile,
  commandStyle,
  announceLifecycle,
}) {
  validateInstanceName(name);
  await fs.mkdir(bridgeRoot, { recursive: true, mode: 0o750 });
  const paths = bridgePaths(name, bridgeRoot);
  const current = await readBridgeStatus(name, bridgeRoot);
  const config = validateConfig({
    version: 1,
    instance: name,
    channelId: channelId ?? current.config?.channelId ?? "",
    commandStyle: commandStyle ?? current.config?.commandStyle ?? "tellraw",
    announceLifecycle: announceLifecycle ?? current.config?.announceLifecycle ?? true,
  });

  if (tokenFile) {
    const token = (await fs.readFile(tokenFile, "utf8")).trim();
    if (token.length < 20 || /\s/.test(token)) throw new Error("Discord token file does not contain a valid token.");
    await writeAtomic(paths.token, `${token}\n`, 0o640);
  }
  if (enabled === true && !(await exists(paths.token))) throw new Error("Enabling the bridge requires --token-file the first time.");
  await writeAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`, 0o640);
  if (enabled === true) await writeAtomic(paths.enabled, "enabled\n", 0o640);
  if (enabled === false) await fs.rm(paths.enabled, { force: true });
  return readBridgeStatus(name, bridgeRoot);
}
