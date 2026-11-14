#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  MissingJavaError,
  adoptInstance,
  createEmptyInstance,
  createResolvedInstance,
  doctorInstance,
  findAvailablePort,
  portIsAvailable,
  readManifest,
  recommendedJavaPackage,
  serviceAction,
  setEula,
  validateInstanceName,
  validatePort,
} from "./lib/instances.mjs";
import { resolveSpec } from "./lib/specs.mjs";

const execFileAsync = promisify(execFile);
const root = process.env.MCCTL_ROOT || "/srv/minecraft";
const booleanOptions = new Set(["accept-eula", "yes", "accept", "reject", "now"]);
const valueOptions = new Set(["spec", "port", "memory", "java", "launch", "arg"]);

const usage = `mcctl — Minecraft server instance manager

Usage:
  mcctl create NAME [SPEC] [options]
  mcctl adopt NAME --launch PATH [options]
  mcctl resolve SPEC
  mcctl doctor NAME
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
    const result = await createEmptyInstance({ root, name });
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
  const report = await doctorInstance({ root, name });
  for (const check of report.checks) {
    const marker = check.ok ? "ok" : check.severity === "warning" ? "warn" : "error";
    console.log(`[${marker}] ${check.name}: ${check.detail}`);
  }
  if (!report.ok) process.exitCode = 1;
  return report;
}

async function activeState(unit, runCommand) {
  try {
    const { stdout } = await runCommand("/usr/bin/systemctl", ["is-active", unit]);
    return stdout.trim() || "unknown";
  } catch (error) {
    return error.stdout?.trim() || "inactive";
  }
}

export async function resolveInstanceService(name, managed, runCommand = execFileAsync) {
  const genericUnit = `minecraft@${name}.service`;
  const genericState = await activeState(genericUnit, runCommand);
  if (genericState === "active") return { unit: genericUnit, state: genericState };

  const standaloneUnit = `${name}.service`;
  const standaloneState = await activeState(standaloneUnit, runCommand);
  if (standaloneState === "active") return { unit: standaloneUnit, state: standaloneState };
  if (!managed) {
    try {
      const { stdout } = await runCommand("/usr/bin/systemctl", ["show", "--property=LoadState", "--value", standaloneUnit]);
      if (stdout.trim() !== "not-found") return { unit: standaloneUnit, state: standaloneState };
    } catch {
      // Fall back to the generic unit.
    }
  }
  return { unit: genericUnit, state: genericState };
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
  console.log(
    `${"NAME".padEnd(20)} ${"SERVICE".padEnd(30)} ${"STATUS".padEnd(10)} ${"MCCTL".padEnd(10)} SPEC`,
  );
  for (const entry of entries.filter((entry) => entry.isDirectory() && /^[a-z0-9]/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const directory = path.join(root, entry.name);
    let manifest = null;
    try {
      manifest = await readManifest(directory);
    } catch {
      // Legacy/unmanaged instance.
    }
    const service = await resolveInstanceService(entry.name, Boolean(manifest));
    console.log(
      `${entry.name.padEnd(20)} ${service.unit.padEnd(30)} ${service.state.padEnd(10)} ${(manifest?.state || "external").padEnd(10)} ${manifest?.requestedSpec || "-"}`,
    );
  }
  console.log("\nexternal = existing server without an mcctl instance manifest; - = no recorded spec");
}

async function eulaCommand(parsed) {
  requireRoot("eula");
  ensureKnownOptions(parsed, ["accept", "reject"]);
  requirePositionalCount(parsed, 1, 1, "eula NAME --accept|--reject");
  if (parsed.has("accept") === parsed.has("reject")) throw new Error("Specify exactly one of --accept or --reject.");
  const name = validateInstanceName(parsed.positional[0]);
  await setEula({ root, name, accepted: parsed.has("accept") });
  console.log(`${name}: EULA ${parsed.has("accept") ? "accepted" : "rejected"}.`);
}

async function systemdCommand(command, parsed) {
  requireRoot(command);
  ensureKnownOptions(parsed, command === "enable" || command === "disable" ? ["now"] : []);
  requirePositionalCount(parsed, 1, 1, `${command} NAME`);
  const name = validateInstanceName(parsed.positional[0]);
  if (command === "start" || command === "restart" || (command === "enable" && parsed.has("now"))) {
    const report = await doctorInstance({ root, name });
    if (!report.ok) throw new Error(`Doctor checks failed for ${name}.`);
    if (!report.eulaAccepted) throw new Error(`EULA is not accepted. Run: mcctl eula ${name} --accept`);
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
  let exitCode = 0;
  const result = await execFileAsync("/usr/bin/systemctl", ["status", `minecraft@${name}.service`, "--no-pager", "--lines=20"], {
    maxBuffer: 1024 * 1024,
  }).catch((error) => {
    exitCode = Number.isInteger(error.code) ? error.code : 1;
    return { stdout: error.stdout || "", stderr: error.stderr || "" };
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (exitCode) process.exitCode = exitCode;
}

async function consoleCommand(parsed) {
  requireRoot("console");
  ensureKnownOptions(parsed, []);
  requirePositionalCount(parsed, 1, 1, "console NAME");
  const name = validateInstanceName(parsed.positional[0]);
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
