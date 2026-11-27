import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const MEMORY_PATTERN = /^\d+[MG]$/i;
const MANIFEST_VERSION = 1;
const DEFAULT_INSTANCE_ROOT = "/srv/minecraft";
export const DEFAULT_MANIFEST_ROOT = "/etc/mcctl/instances";

export function manifestRootFor(instanceRoot) {
  return path.resolve(instanceRoot) === DEFAULT_INSTANCE_ROOT
    ? DEFAULT_MANIFEST_ROOT
    : path.join(instanceRoot, ".mcctl-manifests");
}

export class MissingJavaError extends Error {
  constructor(requiredMajor) {
    super(`Java ${requiredMajor} is required but is not installed.`);
    this.name = "MissingJavaError";
    this.requiredMajor = requiredMajor;
  }
}

export function validateInstanceName(name) {
  if (!INSTANCE_PATTERN.test(name || "")) {
    throw new Error("Instance names must start with a lowercase letter or digit and contain only a-z, 0-9, _ or -.");
  }
  return name;
}

export function validatePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid TCP port: ${value}`);
  return port;
}

export function validateMemory(value) {
  if (!MEMORY_PATTERN.test(value || "")) throw new Error(`Invalid memory value "${value}"; use values such as 4G or 4096M.`);
  return value.toUpperCase();
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function setServerProperty(source, key, value) {
  const lines = source ? source.split(/\r?\n/) : [];
  while (lines.at(-1) === "") lines.pop();
  let replaced = false;
  const output = lines.map((line) => {
    if (!line.startsWith(`${key}=`)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) output.push(`${key}=${value}`);
  return `${output.join("\n")}\n`;
}

export function buildRunScript({ javaPath, memory, kind, jar = null }) {
  const java = shellQuote(javaPath);
  if (kind === "jar") {
    return `#!/bin/sh\nexec ${java} -Xms${memory} -Xmx${memory} -jar ${shellQuote(jar || "server.jar")} nogui\n`;
  }
  if (kind === "generated-run-sh") {
    const javaDirectory = shellQuote(path.dirname(javaPath));
    return `#!/bin/sh\nexport PATH=${javaDirectory}:"$PATH"\nexec /bin/bash ./run.sh nogui\n`;
  }
  throw new Error(`Unsupported launch kind: ${kind}`);
}

export function buildAdoptedRunScript(launch, args = []) {
  if (!launch || launch.includes("\0")) throw new Error("A launch path is required.");
  const command = launch.endsWith(".sh") ? ["/bin/bash", launch, ...args] : [launch, ...args];
  return `#!/bin/sh\nexec ${command.map(shellQuote).join(" ")}\n`;
}

async function pathExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

async function executableExists(filename) {
  try {
    return Boolean((await fs.stat(filename)).mode & 0o111);
  } catch {
    return false;
  }
}

async function readEulaAccepted(directory) {
  const filename = path.join(directory, "eula.txt");
  if (!(await pathExists(filename))) return false;
  return /(?:^|\n)eula=true(?:\n|$)/.test(await fs.readFile(filename, "utf8"));
}

async function hashFile(filename, algorithm) {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest("hex");
}

async function runAsUser(command, args, options, user, runCommand = execFileAsync) {
  if (!user) return runCommand(command, args, options);
  return runCommand("/usr/sbin/runuser", ["--user", user, "--", command, ...args], options);
}

async function writeServerFile(filename, content, { mode, user, runCommand = execFileAsync }) {
  if (!user) {
    await fs.writeFile(filename, content, { mode });
    return;
  }
  const temporary = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/sbin/runuser", ["--user", user, "--", "/usr/bin/tee", temporary], {
        stdio: ["pipe", "ignore", "pipe"],
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Unable to write ${filename} as ${user}: ${stderr.trim() || `exit ${code}`}`));
      });
      child.stdin.on("error", (error) => {
        if (error.code !== "EPIPE") reject(error);
      });
      child.stdin.end(content);
    });
    await runAsUser("/usr/bin/chmod", [mode.toString(8), temporary], {}, user, runCommand);
    await runAsUser("/usr/bin/mv", ["-f", "--", temporary, filename], {}, user, runCommand);
  } finally {
    await runAsUser("/usr/bin/rm", ["-f", "--", temporary], {}, user, runCommand).catch(() => undefined);
  }
}

async function javaMajor(javaPath, { user = "minecraft", runCommand = execFileAsync } = {}) {
  try {
    const { stdout, stderr } = await runAsUser(
      javaPath,
      ["-version"],
      { timeout: 10_000, maxBuffer: 128 * 1024 },
      user,
      runCommand,
    );
    const output = `${stderr}\n${stdout}`;
    const version = /version "([^"]+)"/.exec(output)?.[1];
    if (!version) return null;
    const parts = version.split(".");
    return Number(parts[0] === "1" ? parts[1] : parts[0]);
  } catch {
    return null;
  }
}

async function javaCandidates() {
  const candidates = new Set([
    "/usr/lib/jvm/temurin-8-jre-amd64/bin/java",
    "/usr/lib/jvm/java-8-openjdk-amd64/bin/java",
    "/usr/lib/jvm/java-16-openjdk-amd64/bin/java",
    "/usr/lib/jvm/java-17-openjdk-amd64/bin/java",
    "/usr/lib/jvm/java-21-openjdk-amd64/bin/java",
    "/usr/bin/java",
  ]);
  try {
    for (const entry of await fs.readdir("/usr/lib/jvm")) candidates.add(path.join("/usr/lib/jvm", entry, "bin", "java"));
  } catch {
    // Known paths are still checked.
  }
  return [...candidates];
}

export async function findJava(requiredMajor, explicitPath = null, { user = "minecraft", runCommand = execFileAsync } = {}) {
  if (explicitPath) {
    const detected = await javaMajor(explicitPath, { user, runCommand });
    if (detected !== requiredMajor) {
      throw new Error(`Expected Java ${requiredMajor} at ${explicitPath}, but detected ${detected ?? "no runnable Java"}.`);
    }
    return explicitPath;
  }
  for (const candidate of await javaCandidates()) {
    if ((await javaMajor(candidate, { user, runCommand })) === requiredMajor) return candidate;
  }
  throw new MissingJavaError(requiredMajor);
}

export function recommendedJavaPackage(major) {
  if (major === 8) return "temurin-8-jre";
  return `openjdk-${major}-jre-headless`;
}

async function downloadArtifact(artifact, directory, fetchImpl = fetch) {
  const destination = path.join(directory, artifact.filename);
  const temporary = `${destination}.download`;
  const response = await fetchImpl(artifact.url, {
    headers: { "User-Agent": "mcctl/0.1 (+https://github.com/rozalily/mcctl)" },
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}): ${artifact.url}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { mode: 0o640 }));
  const sha1 = await hashFile(temporary, "sha1");
  const sha256 = await hashFile(temporary, "sha256");
  if (artifact.sha1 && sha1.toLowerCase() !== artifact.sha1.toLowerCase()) {
    await fs.rm(temporary, { force: true });
    throw new Error(`SHA-1 mismatch for ${artifact.url}`);
  }
  await fs.rename(temporary, destination);
  return { filename: artifact.filename, url: artifact.url, sha1, sha256, size: (await fs.stat(destination)).size };
}

async function runInstaller(directory, javaPath, installKind, user, runCommand = execFileAsync) {
  await runAsUser(
    javaPath,
    ["-jar", "installer.jar", "--installServer"],
    { cwd: directory, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024 },
    user,
    runCommand,
  );
  const entries = await fs.readdir(directory);
  if (entries.includes("run.sh")) return { kind: "generated-run-sh", jar: null };
  const forgeJar = entries
    .filter((entry) => /^forge-.+\.jar$/.test(entry) && !entry.includes("installer") && !entry.includes("sources"))
    .sort((left, right) => Number(right.includes("universal")) - Number(left.includes("universal")))[0];
  if (!forgeJar) throw new Error(`${installKind} completed but no run.sh or Forge server JAR was produced.`);
  return { kind: "jar", jar: forgeJar };
}

function manifestFilename(directory, manifestRoot) {
  const name = validateInstanceName(path.basename(path.resolve(directory)));
  return path.join(manifestRoot, `${name}.json`);
}

async function writeManifest(directory, manifest, manifestRoot) {
  await fs.mkdir(manifestRoot, { recursive: true, mode: 0o750 });
  const filename = manifestFilename(directory, manifestRoot);
  const temporary = path.join(manifestRoot, `.${path.basename(filename)}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o640);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filename);
  } finally {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporary, { force: true });
  }
}

export async function readManifest(directory, manifestRoot = manifestRootFor(path.dirname(path.resolve(directory)))) {
  return JSON.parse(await fs.readFile(manifestFilename(directory, manifestRoot), "utf8"));
}

async function applyOwnership(directory, owner = "minecraft", group = "minecraft", runCommand = execFileAsync) {
  if (!owner) return;
  await runCommand("/usr/bin/chown", ["-R", `${owner}:${group}`, directory]);
}

export async function createEmptyInstance({
  root,
  name,
  owner = "minecraft",
  group = "minecraft",
  manifestRoot = manifestRootFor(root),
  now = new Date(),
  runCommand,
}) {
  validateInstanceName(name);
  await fs.mkdir(root, { recursive: true, mode: 0o755 });
  const finalDirectory = path.join(root, name);
  if (await pathExists(finalDirectory)) throw new Error(`Instance already exists: ${finalDirectory}`);
  const staging = await fs.mkdtemp(path.join(root, `.mcctl-${name}-`));
  await fs.chmod(staging, 0o750);
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    name,
    state: "draft",
    createdAt: now.toISOString(),
    requestedSpec: null,
    resolved: null,
    port: null,
    memory: null,
    javaPath: null,
    eulaAccepted: false,
    launch: null,
  };
  try {
    await applyOwnership(staging, owner, group, runCommand);
    await writeManifest(finalDirectory, manifest, manifestRoot);
    await fs.rename(staging, finalDirectory);
    return { directory: finalDirectory, manifest };
  } catch (error) {
    await fs.rm(manifestFilename(finalDirectory, manifestRoot), { force: true });
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function createResolvedInstance({
  root,
  name,
  resolved,
  port,
  memory = "4G",
  acceptEula = false,
  javaPath = null,
  owner = "minecraft",
  group = "minecraft",
  manifestRoot = manifestRootFor(root),
  now = new Date(),
  fetchImpl = fetch,
  runCommand = execFileAsync,
  javaResolver = findJava,
}) {
  validateInstanceName(name);
  const selectedPort = validatePort(port);
  const selectedMemory = validateMemory(memory);
  const selectedJava = await javaResolver(resolved.javaMajor, javaPath, { user: owner, runCommand });
  await fs.mkdir(root, { recursive: true, mode: 0o755 });
  const finalDirectory = path.join(root, name);
  if (await pathExists(finalDirectory)) throw new Error(`Instance already exists: ${finalDirectory}`);
  const staging = await fs.mkdtemp(path.join(root, `.mcctl-${name}-`));
  await fs.chmod(staging, 0o750);
  try {
    const downloaded = await downloadArtifact(resolved.artifact, staging, fetchImpl);
    await applyOwnership(staging, owner, group, runCommand);
    let launch = { kind: "jar", jar: downloaded.filename };
    if (resolved.installKind.endsWith("installer")) {
      launch = await runInstaller(staging, selectedJava, resolved.installKind, owner, runCommand);
      await fs.rm(path.join(staging, "installer.jar"), { force: true });
    }
    if (launch.kind === "generated-run-sh") {
      await writeServerFile(
        path.join(staging, "user_jvm_args.txt"),
        `-Xms${selectedMemory}\n-Xmx${selectedMemory}\n`,
        { mode: 0o640, user: owner, runCommand },
      );
    }
    await writeServerFile(
      path.join(staging, "run"),
      buildRunScript({ javaPath: selectedJava, memory: selectedMemory, kind: launch.kind, jar: launch.jar }),
      { mode: 0o750, user: owner, runCommand },
    );
    let properties = "";
    properties = setServerProperty(properties, "server-port", selectedPort);
    properties = setServerProperty(properties, "query.port", selectedPort);
    properties = setServerProperty(properties, "online-mode", "true");
    properties = setServerProperty(properties, "motd", name);
    await writeServerFile(path.join(staging, "server.properties"), properties, {
      mode: 0o640,
      user: owner,
      runCommand,
    });
    await writeServerFile(path.join(staging, "eula.txt"), `eula=${acceptEula ? "true" : "false"}\n`, {
      mode: 0o640,
      user: owner,
      runCommand,
    });
    const manifest = {
      manifestVersion: MANIFEST_VERSION,
      name,
      state: "installed",
      createdAt: now.toISOString(),
      requestedSpec: resolved.requestedSpec,
      resolved: {
        distribution: resolved.distribution,
        minecraftVersion: resolved.minecraftVersion,
        loaderVersion: resolved.loaderVersion,
        installerVersion: resolved.installerVersion,
        javaMajor: resolved.javaMajor,
      },
      artifact: downloaded,
      port: selectedPort,
      memory: selectedMemory,
      javaPath: selectedJava,
      eulaAccepted: acceptEula,
      launch,
    };
    await writeManifest(finalDirectory, manifest, manifestRoot);
    await fs.rename(staging, finalDirectory);
    return { directory: finalDirectory, manifest };
  } catch (error) {
    await fs.rm(manifestFilename(finalDirectory, manifestRoot), { force: true });
    await fs.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function adoptInstance({
  root,
  name,
  launch,
  args = [],
  port = null,
  javaPath = null,
  memory = null,
  owner = "minecraft",
  manifestRoot = manifestRootFor(root),
  now = new Date(),
  runCommand = execFileAsync,
}) {
  validateInstanceName(name);
  const directory = path.join(root, name);
  if (!(await pathExists(directory))) throw new Error(`Instance does not exist: ${directory}`);
  const launcher = path.resolve(directory, launch);
  if (!launcher.startsWith(`${directory}${path.sep}`) || !(await pathExists(launcher))) {
    throw new Error(`Launch path must exist inside the instance: ${launch}`);
  }
  const propertiesPath = path.join(directory, "server.properties");
  let properties = (await pathExists(propertiesPath)) ? await fs.readFile(propertiesPath, "utf8") : "";
  const configuredPort = /^server-port=(\d+)$/m.exec(properties)?.[1] || null;
  const selectedPort = port === null ? (configuredPort ? validatePort(configuredPort) : null) : validatePort(port);
  if (selectedPort === null) throw new Error("adopt requires --port unless server.properties already defines server-port.");
  const selectedMemory = memory ? validateMemory(memory) : null;
  const runScript = buildAdoptedRunScript(launch, args);
  const manifest = await readManifest(directory, manifestRoot);
  await writeServerFile(path.join(directory, "run"), runScript, { mode: 0o750, user: owner, runCommand });
  if (port !== null) {
    properties = setServerProperty(properties, "server-port", selectedPort);
    properties = setServerProperty(properties, "query.port", selectedPort);
    await writeServerFile(propertiesPath, properties, { mode: 0o640, user: owner, runCommand });
  }
  manifest.state = "adopted";
  manifest.adoptedAt = now.toISOString();
  manifest.port = selectedPort;
  manifest.javaPath = javaPath || manifest.javaPath || null;
  manifest.memory = selectedMemory ?? manifest.memory ?? null;
  manifest.launch = { kind: "adopted", path: launch, args };
  manifest.eulaAccepted = await readEulaAccepted(directory);
  await writeManifest(directory, manifest, manifestRoot);
  return { directory, manifest };
}

export async function setEula({
  root,
  name,
  accepted,
  owner = "minecraft",
  manifestRoot = manifestRootFor(root),
  runCommand = execFileAsync,
}) {
  validateInstanceName(name);
  const directory = path.join(root, name);
  const manifest = await readManifest(directory, manifestRoot);
  manifest.eulaAccepted = accepted;
  await writeServerFile(path.join(directory, "eula.txt"), `eula=${accepted ? "true" : "false"}\n`, {
    mode: 0o640,
    user: owner,
    runCommand,
  });
  await writeManifest(directory, manifest, manifestRoot);
  return manifest;
}

async function portIsListening(port, runCommand = execFileAsync) {
  const { stdout } = await runCommand("/usr/bin/ss", ["-ltnH"]);
  return stdout.split(/\r?\n/).some((line) => new RegExp(`[:.]${port}\\s`).test(`${line} `));
}

export async function portIsAvailable(port, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export async function findAvailablePort(start = 25565) {
  for (let port = start; port <= 65535; port += 1) if (await portIsAvailable(port)) return port;
  throw new Error("No available TCP port was found.");
}

export async function doctorInstance({ root, name, manifestRoot = manifestRootFor(root), runCommand = execFileAsync }) {
  validateInstanceName(name);
  const directory = path.join(root, name);
  const checks = [];
  const add = (name, ok, detail, severity = "error") => checks.push({ name, ok, detail, severity });
  let manifest = null;
  try {
    manifest = await readManifest(directory, manifestRoot);
    add("manifest", true, `${manifest.state || "unknown"} instance`);
  } catch (error) {
    add("manifest", false, error.message);
  }
  const runPath = path.join(directory, "run");
  add("launcher", await executableExists(runPath), runPath);
  if (manifest?.javaPath && manifest.resolved?.javaMajor) {
    const detected = await javaMajor(manifest.javaPath, { runCommand });
    add("java", detected === manifest.resolved.javaMajor, `required ${manifest.resolved.javaMajor}, detected ${detected ?? "none"}`);
  }
  if (manifest?.port) {
    const listening = await portIsListening(manifest.port, runCommand).catch(() => false);
    let active = false;
    try {
      const { stdout } = await runCommand("/usr/bin/systemctl", ["is-active", `minecraft@${name}.service`]);
      active = stdout.trim() === "active";
    } catch {
      active = false;
    }
    const free = listening ? false : await portIsAvailable(manifest.port);
    add("port", active ? listening : free, active ? `listening on ${manifest.port}` : free ? `${manifest.port} available` : `${manifest.port} in use`);
  }
  const eulaAccepted = await readEulaAccepted(directory);
  add("eula", eulaAccepted, eulaAccepted ? "accepted" : "not accepted", "warning");
  if (manifest && Boolean(manifest.eulaAccepted) !== eulaAccepted) {
    add("eula manifest", false, "instance.json does not match eula.txt", "warning");
  }
  return { directory, manifest, eulaAccepted, checks, ok: checks.every((check) => check.ok || check.severity === "warning") };
}

export async function serviceAction(action, name, { runCommand = execFileAsync, now = false } = {}) {
  validateInstanceName(name);
  const service = `minecraft@${name}.service`;
  const args = action === "enable" && now ? ["enable", "--now", service] : [action, service];
  const result = await runCommand("/usr/bin/systemctl", args, { maxBuffer: 1024 * 1024 });
  return { service, stdout: result.stdout?.trim() || "" };
}
