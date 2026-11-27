#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { bridgeRootFor, configureBridge, readBridgeStatus } from "./lib/bridge-config.mjs";
import {
  MissingJavaError,
  adoptInstance,
  createEmptyInstance,
  createResolvedInstance,
  doctorInstance,
  findAvailablePort,
  manifestRootFor,
  portIsAvailable,
  readManifest,
  recommendedJavaPackage,
  serviceAction,
  setEula,
  validateInstanceName,
  validatePort,
} from "./lib/instances.mjs";
import { queryPlayerCount, readLoggedVersion } from "./lib/minecraft-status.mjs";
import { resolveSpec } from "./lib/specs.mjs";

const execFileAsync = promisify(execFile);
const root = process.env.MCCTL_ROOT || "/srv/minecraft";
const manifestRoot = process.env.MCCTL_MANIFEST_ROOT || manifestRootFor(root);
const bridgeRoot = process.env.MCCTL_BRIDGE_ROOT || bridgeRootFor(root);
const rendererPluginSource =
  process.env.MCCTL_RENDERER_PLUGIN || path.join(path.dirname(fileURLToPath(import.meta.url)), "bridge/renderer/mcctl-bridge-renderer.jar");
const booleanOptions = new Set(["accept-eula", "yes", "accept", "reject", "now", "enable", "disable", "announce", "no-announce"]);
const valueOptions = new Set(["spec", "port", "memory", "java", "launch", "arg", "channel", "token-file", "command-style"]);

const usage = `mcctl — Minecraft server instance manager

Usage:
  mcctl create NAME [SPEC] [options]
  mcctl adopt NAME --launch PATH [options]
  mcctl resolve SPEC
  mcctl doctor NAME
  mcctl bridge NAME [options]
  mcctl list
  mcctl eula NAME --accept|--reject
  mcctl enable NAME [--now]
  mcctl disable NAME [--now]
  mcctl start|stop|restart|status NAME
  mcctl console NAME

Specs:
  latest-vanilla
  latest-fabric
  1.21.1-fabric[@LOADER_VERSION]
  1.12.2-forge[@LOADER_VERSION]
  1.21.1-neoforge[@LOADER_VERSION]

Create options:
  --spec SPEC          Alternative to the positional spec
  --port PORT          Defaults to the first free port from 25566
  --memory SIZE        Java heap, default 4G
  --java PATH          Pin a specific compatible Java executable
  --accept-eula        Write eula=true (never implied)
  --yes                Accept the suggested port without prompting

Adopt options:
  --launch PATH        Existing launcher inside the instance directory
  --arg VALUE          Repeatable launcher argument
  --port PORT          Write server-port and query.port
  --memory SIZE        Record configured memory
  --java PATH          Record Java path

Bridge options:
  --enable             Enable after configuration
  --disable            Disable without deleting configuration
  --channel ID         Discord text channel ID
  --token-file PATH    Read the Discord bot token from a file
  --command-style MODE tellraw (modern), say (Beta), or broadcast (Bukkit)
  --announce           Announce bridge start/stop in Discord
  --no-announce        Do not announce bridge start/stop
`;

export function parseArguments(tokens) {
  const positional = [];
  const options = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const key = token.slice(2, equals < 0 ? undefined : equals);
    let value = equals < 0 ? null : token.slice(equals + 1);
    if (booleanOptions.has(key)) {
      if (equals >= 0) throw new Error(`--${key} does not accept a value.`);
      value = true;
    } else if (valueOptions.has(key) && value === null) {
      if (!tokens[index + 1] || tokens[index + 1].startsWith("--")) throw new Error(`--${key} requires a value.`);
      value = tokens[++index];
    } else if (value === null) {
      value = true;
    }
    const values = options.get(key) || [];
    values.push(value ?? true);
    options.set(key, values);
  }
  return {
    positional,
    has: (key) => options.has(key),
    get: (key, fallback = null) => options.get(key)?.at(-1) ?? fallback,
    all: (key) => options.get(key) || [],
    keys: () => [...options.keys()],
  };
}

function parseSystemdProperties(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function finiteNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatBytes(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits).replace(/\.0$/, "")} ${units[unit]}`;
}

function formatDuration(milliseconds) {
  let seconds = Math.max(0, Math.floor(milliseconds / 1000));
  const days = Math.floor(seconds / 86_400);
  seconds %= 86_400;
  const hours = Math.floor(seconds / 3_600);
  seconds %= 3_600;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (seconds || parts.length === 0) parts.push(`${seconds}s`);
  return parts.slice(0, 2).join(" ");
}

export function formatInstanceStatus({ name, manifest, systemd, portDetail, playerCount, nowMonotonicUs }) {
  const unit = `minecraft@${name}.service`;
  const active = systemd.ActiveState === "active";
  let state = systemd.ActiveState || "unknown";
  if (active && systemd.SubState === "running") state = "running";
  else if (systemd.ActiveState === "activating") state = "starting";
  else if (systemd.ActiveState === "failed") {
    const exitStatus = finiteNumber(systemd.ExecMainStatus);
    state = `failed${exitStatus && exitStatus > 0 ? ` (exit ${exitStatus})` : ""}`;
  }

  const formattedPort = portDetail
    ?.replace(/^listening on (\d+)$/, "$1 · listening")
    .replace(/^(\d+) (available|in use)$/, "$1 · $2");
  const rows = [
    ["State", state],
    ["Service", `${systemd.UnitFileState || "unknown"} · ${unit}`],
    ["Port", formattedPort || (manifest.port ? String(manifest.port) : "not configured")],
  ];
  if (active) {
    rows.push(["Players", playerCount ? `${playerCount.online}/${playerCount.max ?? "?"}` : "unavailable"]);
  }
  const timestamp = finiteNumber(active ? systemd.ActiveEnterTimestampMonotonic : systemd.StateChangeTimestampMonotonic);
  if (timestamp !== null && timestamp > 0 && nowMonotonicUs >= timestamp) {
    rows.push([active ? "Uptime" : "Stopped", `${formatDuration((nowMonotonicUs - timestamp) / 1000)}${active ? "" : " ago"}`]);
  }

  const memory = [];
  const currentMemory = finiteNumber(systemd.MemoryCurrent);
  const peakMemory = finiteNumber(systemd.MemoryPeak);
  if (currentMemory !== null) memory.push(`${formatBytes(currentMemory)} current`);
  if (peakMemory !== null && peakMemory !== currentMemory) memory.push(`${formatBytes(peakMemory)} peak`);
  if (manifest.memory) memory.push(`${manifest.memory} configured`);
  if (memory.length) rows.push(["Memory", memory.join(" · ")]);

  const cpuNs = finiteNumber(systemd.CPUUsageNSec);
  if (cpuNs !== null) rows.push(["CPU time", formatDuration(cpuNs / 1_000_000)]);
  const restarts = finiteNumber(systemd.NRestarts);
  if (restarts && restarts > 0) rows.push(["Restarts", String(restarts)]);
  if (manifest.requestedSpec) rows.push(["Spec", manifest.requestedSpec]);
  if (active) rows.push(["Console", `mcctl console ${name}`]);

  const width = Math.max(...rows.map(([label]) => label.length));
  return [`${name}`, ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`)].join("\n");
}

function compactMemory(bytes, configured) {
  const current = bytes !== null ? formatBytes(bytes).replace(" ", "") : null;
  if (current && configured) return `${current}/${configured}`;
  return current || (configured ? `-/${configured}` : "-");
}

function conciseState(systemd, listening) {
  if (systemd.ActiveState === "active") return listening ? "running" : "unhealthy";
  if (systemd.ActiveState === "activating") return "starting";
  if (systemd.ActiveState === "failed") return "failed";
  if (systemd.ActiveState === "deactivating") return "stopping";
  return "stopped";
}

function truncateCell(value, length = 20) {
  const text = String(value);
  return text.length <= length ? text : `${text.slice(0, length - 3)}...`;
}

export function formatInstanceList(records) {
  if (records.length === 0) return "No managed instances.";
  const columns = [
    ["NAME", "name"],
    ["STATE", "state"],
    ["PLAYERS", "players"],
    ["VERSION", "version"],
    ["PORT", "port"],
    ["MEMORY", "memory"],
    ["UPTIME", "uptime"],
    ["BOOT", "boot"],
  ];
  const widths = columns.map(([header, key]) => Math.max(header.length, ...records.map((record) => String(record[key]).length)));
  const row = (values) => values.map((value, index) => String(value).padEnd(widths[index])).join("  ").trimEnd();
  return [row(columns.map(([header]) => header)), ...records.map((record) => row(columns.map(([, key]) => record[key])))].join("\n");
}

async function listRecord(name, manifest, nowMonotonicUs, listeningPorts) {
  const directory = path.join(root, name);
  const unit = `minecraft@${name}.service`;
  const propertyNames = ["ActiveState", "SubState", "UnitFileState", "MemoryCurrent", "ActiveEnterTimestampMonotonic"];
  const [{ stdout }, properties] = await Promise.all([
    execFileAsync("/usr/bin/systemctl", ["show", unit, `--property=${propertyNames.join(",")}`, "--no-pager"], {
      maxBuffer: 64 * 1024,
    }).catch((error) => ({ stdout: error.stdout || "" })),
    fs.readFile(path.join(directory, "server.properties"), "utf8").catch(() => ""),
  ]);
  const systemd = parseSystemdProperties(stdout);
  const configuredPort = Number.parseInt(/^server-port=(\d+)$/m.exec(properties)?.[1] || "", 10);
  const configuredMax = Number.parseInt(/^max-players=(\d+)$/m.exec(properties)?.[1] || "", 10);
  const port = manifest.port ?? (Number.isNaN(configuredPort) ? null : configuredPort);
  const listening = port !== null && listeningPorts.has(port);
  const active = systemd.ActiveState === "active";
  const legacyLogPath = path.join(directory, "server.log");
  const modernLogPath = path.join(directory, "logs", "latest.log");
  const [hasLegacyLog, hasModernLog] = await Promise.all([
    fs.access(legacyLogPath).then(() => true).catch(() => false),
    fs.access(modernLogPath).then(() => true).catch(() => false),
  ]);
  const runtime =
    active && listening && port !== null
      ? await queryPlayerCount(port, {
          legacyLogPath: hasLegacyLog ? legacyLogPath : null,
          maxPlayers: Number.isNaN(configuredMax) ? null : configuredMax,
        }).catch(() => null)
      : null;
  const loggedVersion = await readLoggedVersion(hasModernLog ? modernLogPath : legacyLogPath).catch(() => null);
  const timestamp = finiteNumber(systemd.ActiveEnterTimestampMonotonic);
  const uptime =
    active && timestamp !== null && timestamp > 0 && nowMonotonicUs >= timestamp
      ? formatDuration((nowMonotonicUs - timestamp) / 1000)
      : "-";
  const memoryCurrent = finiteNumber(systemd.MemoryCurrent);
  const playersMax = runtime?.max ?? (Number.isNaN(configuredMax) ? null : configuredMax);
  return {
    name,
    state: conciseState(systemd, listening),
    players: active ? (runtime ? `${runtime.online}/${playersMax ?? "?"}` : `?/${playersMax ?? "?"}`) : "-",
    version: truncateCell(runtime?.version || manifest.resolved?.minecraftVersion || loggedVersion || "-"),
    port: port ?? "-",
    memory: compactMemory(memoryCurrent, manifest.memory),
    uptime,
    boot: systemd.UnitFileState === "enabled" ? "yes" : "no",
  };
}

function requirePositionalCount(parsed, minimum, maximum, synopsis) {
  if (parsed.positional.length < minimum || parsed.positional.length > maximum) {
    throw new Error(`Expected: mcctl ${synopsis}`);
  }
}

function requireRoot(command) {
  if (process.getuid?.() !== 0) {
    throw new Error(`${command} requires root. Use the installed /usr/local/bin/mcctl wrapper or run with sudo.`);
  }
}

function ensureKnownOptions(parsed, allowed) {
  const unknown = parsed.keys().filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Error(`Unknown option${unknown.length === 1 ? "" : "s"}: ${unknown.map((key) => `--${key}`).join(", ")}`);
}

async function choosePort(parsed) {
  if (parsed.has("port")) {
    const port = validatePort(parsed.get("port"));
    if (!(await portIsAvailable(port))) throw new Error(`TCP port ${port} is already in use.`);
    return port;
  }
  const suggested = await findAvailablePort(25566);
  if (parsed.has("yes") || !process.stdin.isTTY) {
    console.log(`Using available port ${suggested}.`);
    return suggested;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await readline.question(`Server port [${suggested}]: `)).trim();
    const port = validatePort(answer || suggested);
    if (!(await portIsAvailable(port))) throw new Error(`TCP port ${port} is already in use.`);
    return port;
  } finally {
    readline.close();
  }
}

function printResolved(resolved) {
  console.log(`Spec:       ${resolved.requestedSpec}`);
  console.log(`Minecraft:  ${resolved.minecraftVersion}`);
  console.log(`Loader:     ${resolved.distribution}${resolved.loaderVersion ? ` ${resolved.loaderVersion}` : ""}`);
  if (resolved.installerVersion) console.log(`Installer:  ${resolved.installerVersion}`);
  console.log(`Java:       ${resolved.javaMajor}`);
  console.log(`Artifact:   ${resolved.artifact.url}`);
  console.log(`SHA-1:      ${resolved.artifact.sha1 || "not published; SHA-256 will be recorded after download"}`);
}

async function createCommand(parsed) {
  requireRoot("create");
  ensureKnownOptions(parsed, ["spec", "port", "memory", "java", "accept-eula", "yes"]);
  requirePositionalCount(parsed, 1, 2, "create NAME [SPEC]");
  if (parsed.has("spec") && parsed.positional[1]) throw new Error("Specify a server spec either positionally or with --spec, not both.");
  const name = validateInstanceName(parsed.positional[0]);
  const spec = parsed.get("spec") || parsed.positional[1] || null;
  if (!spec) {
    const invalid = ["port", "memory", "java", "accept-eula", "yes"].filter((option) => parsed.has(option));
    if (invalid.length) throw new Error(`${invalid.map((option) => `--${option}`).join(", ")} requires a server spec.`);
    const result = await createEmptyInstance({ root, name, manifestRoot });
    console.log(`Created empty draft: ${result.directory}`);
    console.log(`Add server files, then run: mcctl adopt ${name} --launch ./start.sh --port PORT`);
    return;
  }
  console.log(`Resolving ${spec}...`);
  const resolved = await resolveSpec(spec);
  printResolved(resolved);
  const port = await choosePort(parsed);
  const memory = parsed.get("memory", "4G");
  console.log(`Downloading and staging ${name}...`);
  const result = await createResolvedInstance({
    root,
    name,
    manifestRoot,
    resolved,
    port,
    memory,
    acceptEula: parsed.has("accept-eula"),
    javaPath: parsed.get("java"),
  });
  console.log(`Installed:   ${result.directory}`);
  console.log(`Port:        ${result.manifest.port}`);
  console.log(`Java:        ${result.manifest.javaPath}`);
  console.log(`EULA:        ${result.manifest.eulaAccepted ? "accepted" : "not accepted"}`);
  console.log(`Next:        mcctl doctor ${name}`);
  if (!result.manifest.eulaAccepted) console.log(`Then:        mcctl eula ${name} --accept`);
  console.log(`Enable:      mcctl enable ${name} --now`);
}

async function adoptCommand(parsed) {
  requireRoot("adopt");
  ensureKnownOptions(parsed, ["launch", "arg", "port", "memory", "java"]);
  requirePositionalCount(parsed, 1, 1, "adopt NAME --launch PATH [options]");
  const name = validateInstanceName(parsed.positional[0]);
  if (!parsed.get("launch")) throw new Error("adopt requires --launch PATH.");
  const result = await adoptInstance({
    root,
    name,
    manifestRoot,
    launch: parsed.get("launch"),
    args: parsed.all("arg").map(String),
    port: parsed.has("port") ? validatePort(parsed.get("port")) : null,
    memory: parsed.get("memory"),
    javaPath: parsed.get("java"),
  });
  console.log(`Adopted ${name}: ${result.directory}`);
  console.log(`Next: mcctl doctor ${name}`);
}

async function doctorCommand(parsed) {
  ensureKnownOptions(parsed, []);
  requirePositionalCount(parsed, 1, 1, "doctor NAME");
  const name = validateInstanceName(parsed.positional[0]);
  const report = await doctorInstance({ root, name, manifestRoot });
  for (const check of report.checks) {
    const marker = check.ok ? "ok" : check.severity === "warning" ? "warn" : "error";
    console.log(`[${marker}] ${check.name}: ${check.detail}`);
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

async function syncBridgeRenderer(name, commandStyle) {
  const plugins = path.join(root, name, "plugins");
  const target = path.join(plugins, "McctlBridgeRenderer.jar");
  const productionRoot = path.resolve(root) === "/srv/minecraft";
  if (commandStyle !== "broadcast") {
    if (productionRoot) {
      await execFileAsync("/usr/sbin/runuser", ["--user", "minecraft", "--", "/usr/bin/rm", "-f", target]);
    } else {
      await fs.rm(target, { force: true });
    }
    return;
  }

  await fs.access(rendererPluginSource);
  if (productionRoot) {
    await execFileAsync("/usr/sbin/runuser", ["--user", "minecraft", "--", "/usr/bin/install", "-d", "-m", "0750", plugins]);
    await execFileAsync("/usr/sbin/runuser", [
      "--user",
      "minecraft",
      "--",
      "/usr/bin/install",
      "-m",
      "0644",
      rendererPluginSource,
      target,
    ]);
  } else {
    await fs.mkdir(plugins, { recursive: true, mode: 0o750 });
    await fs.copyFile(rendererPluginSource, target);
    await fs.chmod(target, 0o644);
  }
}

async function bridgeCommand(parsed) {
  ensureKnownOptions(parsed, ["enable", "disable", "channel", "token-file", "command-style", "announce", "no-announce"]);
  requirePositionalCount(parsed, 1, 1, "bridge NAME [options]");
  const name = validateInstanceName(parsed.positional[0]);
  await readManifest(path.join(root, name), manifestRoot);
  if (parsed.has("enable") && parsed.has("disable")) throw new Error("Specify --enable or --disable, not both.");
  if (parsed.has("announce") && parsed.has("no-announce")) throw new Error("Specify --announce or --no-announce, not both.");
  const requestedChange = ["enable", "disable", "channel", "token-file", "command-style", "announce", "no-announce"].some((option) =>
    parsed.has(option),
  );
  const current = await readBridgeStatus(name, bridgeRoot);
  if (requestedChange && !(parsed.has("disable") && !current.config && !parsed.has("channel") && !parsed.has("token-file"))) {
    const configured = await configureBridge({
      name,
      bridgeRoot,
      enabled: parsed.has("enable") ? true : parsed.has("disable") ? false : undefined,
      channelId: parsed.get("channel"),
      tokenFile: parsed.get("token-file"),
      commandStyle: parsed.get("command-style"),
      announceLifecycle: parsed.has("announce") ? true : parsed.has("no-announce") ? false : undefined,
    });
    await syncBridgeRenderer(name, configured.config?.commandStyle);
  }
  const status = await readBridgeStatus(name, bridgeRoot);
  console.log(`${name} bridge`);
  console.log(`  Enabled      ${status.enabled ? "yes" : "no"}`);
  console.log(`  Channel      ${status.config?.channelId || "not configured"}`);
  console.log(`  Token        ${status.tokenConfigured ? "configured" : "not configured"}`);
  console.log(`  Command      ${status.config?.commandStyle || "tellraw"}`);
  console.log(`  Announcements ${status.config?.announceLifecycle === false ? "no" : "yes"}`);
  if (requestedChange) console.log(`  Apply        mcctl restart ${name}`);
}

async function listCommand(parsed) {
  ensureKnownOptions(parsed, []);
  requirePositionalCount(parsed, 0, 0, "list");
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  const manifests = [];
  for (const entry of entries.filter((entry) => entry.isDirectory() && /^[a-z0-9]/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(root, entry.name);
    try {
      manifests.push([entry.name, await readManifest(directory, manifestRoot)]);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw new Error(`Cannot read manifest for ${entry.name}: ${error.message}`);
    }
  }
  const [uptimeSource, socketResult] = await Promise.all([
    fs.readFile("/proc/uptime", "utf8"),
    execFileAsync("/usr/bin/ss", ["-ltnH"], { maxBuffer: 1024 * 1024 }).catch(() => ({ stdout: "" })),
  ]);
  const listeningPorts = new Set([...socketResult.stdout.matchAll(/:(\d+)\s/g)].map((match) => Number(match[1])));
  const nowMonotonicUs = Number.parseFloat(uptimeSource) * 1_000_000;
  const records = await Promise.all(manifests.map(([name, manifest]) => listRecord(name, manifest, nowMonotonicUs, listeningPorts)));
  console.log(formatInstanceList(records));
}

async function eulaCommand(parsed) {
  requireRoot("eula");
  ensureKnownOptions(parsed, ["accept", "reject"]);
  requirePositionalCount(parsed, 1, 1, "eula NAME --accept|--reject");
  if (parsed.has("accept") === parsed.has("reject")) throw new Error("Specify exactly one of --accept or --reject.");
  const name = validateInstanceName(parsed.positional[0]);
  await setEula({ root, name, accepted: parsed.has("accept"), manifestRoot });
  console.log(`${name}: EULA ${parsed.has("accept") ? "accepted" : "rejected"}.`);
}

async function systemdCommand(command, parsed) {
  requireRoot(command);
  ensureKnownOptions(parsed, command === "enable" || command === "disable" ? ["now"] : []);
  requirePositionalCount(parsed, 1, 1, `${command} NAME`);
  const name = validateInstanceName(parsed.positional[0]);
  const requiresDoctor = command === "start" || command === "restart" || (command === "enable" && parsed.has("now"));
  if (requiresDoctor) {
    const report = await doctorInstance({ root, name, manifestRoot });
    if (!report.ok) throw new Error(`Doctor checks failed for ${name}.`);
    if (!report.eulaAccepted) throw new Error(`EULA is not accepted. Run: mcctl eula ${name} --accept`);
  } else {
    await readManifest(path.join(root, name), manifestRoot);
  }
  if (command === "disable" && parsed.has("now")) {
    await serviceAction("disable", name, { runCommand: execFileAsync });
    await serviceAction("stop", name, { runCommand: execFileAsync });
  } else {
    await serviceAction(command, name, { now: parsed.has("now") });
  }
  console.log(`${command}: minecraft@${name}.service`);
}

async function statusCommand(parsed) {
  ensureKnownOptions(parsed, []);
  requirePositionalCount(parsed, 1, 1, "status NAME");
  const name = validateInstanceName(parsed.positional[0]);
  const directory = path.join(root, name);
  const manifest = await readManifest(directory, manifestRoot);
  const unit = `minecraft@${name}.service`;
  const propertyNames = [
    "ActiveState",
    "SubState",
    "UnitFileState",
    "Result",
    "ExecMainStatus",
    "ActiveEnterTimestampMonotonic",
    "StateChangeTimestampMonotonic",
    "MemoryCurrent",
    "MemoryPeak",
    "CPUUsageNSec",
    "NRestarts",
  ];
  const [{ stdout }, report, uptimeSource] = await Promise.all([
    execFileAsync("/usr/bin/systemctl", ["show", unit, `--property=${propertyNames.join(",")}`, "--no-pager"], {
      maxBuffer: 128 * 1024,
    }),
    doctorInstance({ root, name, manifestRoot }),
    fs.readFile("/proc/uptime", "utf8"),
  ]);
  const systemd = parseSystemdProperties(stdout);
  const portDetail = report.checks.find((check) => check.name === "port")?.detail;
  const legacyLogPath = path.join(directory, "server.log");
  const legacyLogExists = await fs.access(legacyLogPath).then(() => true).catch(() => false);
  const properties = await fs.readFile(path.join(directory, "server.properties"), "utf8").catch(() => "");
  const maxPlayers = Number.parseInt(/^max-players=(\d+)$/m.exec(properties)?.[1] || "", 10);
  const playerCount =
    systemd.ActiveState === "active" && manifest.port
      ? await queryPlayerCount(manifest.port, {
          legacyLogPath: legacyLogExists ? legacyLogPath : null,
          maxPlayers: Number.isNaN(maxPlayers) ? null : maxPlayers,
        }).catch(() => null)
      : null;
  const nowMonotonicUs = Number.parseFloat(uptimeSource) * 1_000_000;
  console.log(formatInstanceStatus({ name, manifest, systemd, portDetail, playerCount, nowMonotonicUs }));
  if (systemd.ActiveState !== "active") process.exitCode = 3;
}

async function consoleCommand(parsed) {
  requireRoot("console");
  ensureKnownOptions(parsed, []);
  requirePositionalCount(parsed, 1, 1, "console NAME");
  const name = validateInstanceName(parsed.positional[0]);
  await readManifest(path.join(root, name), manifestRoot);
  const { spawn } = await import("node:child_process");
  const child = spawn("/usr/local/bin/minecraft-console", [name], {
    stdio: "inherit",
  });
  const code = await new Promise((resolve) => child.once("exit", resolve));
  process.exitCode = code ?? 1;
}

async function main() {
  const command = process.argv[2];
  const parsed = parseArguments(process.argv.slice(3));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(usage);
    return;
  }
  switch (command) {
    case "create":
      return createCommand(parsed);
    case "adopt":
      return adoptCommand(parsed);
    case "resolve": {
      ensureKnownOptions(parsed, []);
      requirePositionalCount(parsed, 1, 1, "resolve SPEC");
      return printResolved(await resolveSpec(parsed.positional[0]));
    }
    case "doctor":
      return doctorCommand(parsed);
    case "bridge":
      return bridgeCommand(parsed);
    case "list":
      return listCommand(parsed);
    case "eula":
      return eulaCommand(parsed);
    case "enable":
    case "disable":
    case "start":
    case "stop":
    case "restart":
      return systemdCommand(command, parsed);
    case "status":
      return statusCommand(parsed);
    case "console":
      return consoleCommand(parsed);
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof MissingJavaError) {
      console.error(error.message);
      console.error(`mcctl will not install packages automatically. Install ${recommendedJavaPackage(error.requiredMajor)} and retry.`);
    } else {
      console.error(`mcctl: ${error.message}`);
    }
    process.exitCode = 1;
  });
}
