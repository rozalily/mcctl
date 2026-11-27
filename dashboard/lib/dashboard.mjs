import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import net from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { collectPlayerProfiles } from "./player-profiles.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_ROOT = "/srv/minecraft";
const DEFAULT_MANIFEST_ROOT = "/etc/mcctl/instances";
const MAX_LOG_BYTES = 768 * 1024;
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;
const legacyPlayerCaches = new Map();
const liveCpuBaselines = new Map();

function calculateLiveCpuPercent(service, cpuUsageNs, now = Date.now()) {
  const previous = liveCpuBaselines.get(service);
  liveCpuBaselines.set(service, { timestamp: now, cpuUsageNs });
  if (!previous || cpuUsageNs < previous.cpuUsageNs || now <= previous.timestamp) return null;
  const elapsedNs = (now - previous.timestamp) * 1_000_000;
  return Number((((cpuUsageNs - previous.cpuUsageNs) / elapsedNs) * 100).toFixed(2));
}

export function parseProperties(source) {
  const properties = {};
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    const separator = line.search(/(?<!\\)[=:]/);
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    properties[key] = decodeProperty(value);
  }
  return properties;
}

function decodeProperty(value) {
  return value
    .replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\([:=\\])/g, "$1");
}

function titleCase(value) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function fileExists(filename) {
  try {
    await fs.access(filename);
    return true;
  } catch {
    return false;
  }
}

export async function discoverServers(root = DEFAULT_ROOT, { manifestRoot = DEFAULT_MANIFEST_ROOT } = {}) {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const servers = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !INSTANCE_PATTERN.test(entry.name)) continue;
    const directory = path.join(root, entry.name);
    const manifestPath = path.join(manifestRoot, `${entry.name}.json`);
    const propertiesPath = path.join(directory, "server.properties");
    if (!(await fileExists(manifestPath)) || !(await fileExists(propertiesPath))) continue;
    try {
      JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch {
      continue;
    }

    const properties = parseProperties(await fs.readFile(propertiesPath, "utf8"));
    const modernLog = path.join(directory, "logs", "latest.log");
    const legacyLog = path.join(directory, "server.log");
    const hasModernLog = await fileExists(modernLog);
    const hasLegacyLog = await fileExists(legacyLog);
    const logPath = hasModernLog ? modernLog : hasLegacyLog ? legacyLog : null;
    const iconPath = path.join(directory, "server-icon.png");
    const hasIcon = await fileExists(iconPath);
    const iconVersion = hasIcon ? Math.trunc((await fs.stat(iconPath)).mtimeMs) : null;
    const port = Number.parseInt(properties["server-port"] || "25565", 10);
    const legacyPing = !hasModernLog && hasLegacyLog;

    servers.push({
      id: entry.name,
      name: titleCase(entry.name),
      directory,
      properties,
      port: Number.isInteger(port) ? port : 25565,
      service: `minecraft@${entry.name}.service`,
      logPath,
      hasIcon,
      iconPath,
      iconVersion,
      legacyPing,
    });
  }
  return servers.sort((a, b) => a.name.localeCompare(b.name));
}

function stripFormatting(value) {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/§x(?:§[0-9a-f]){6}/gi, "")
    .replace(/§[0-9a-fk-or]/gi, "");
}

function sanitize(value, maxLength = 500) {
  return stripFormatting(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function parseModernTimestamp(value) {
  const match = /^(\d{2})([A-Za-z]{3})(\d{4}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(value);
  if (!match) return null;
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const month = months[match[2]];
  if (month === undefined) return null;
  return new Date(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  ).toISOString();
}

function classifyMessage(serverId, timestamp, payload) {
  const chat = /^(?:\[Not Secure\] )?<([^>]{1,32})> (.+)$/.exec(payload);
  if (chat) {
    return {
      serverId,
      timestamp,
      type: "chat",
      player: sanitize(chat[1], 32),
      message: sanitize(chat[2], 500),
    };
  }

  const presence = /^([^\s]{1,32}) (?:(joined|left) the game|has (left) the game\.?)$/.exec(payload);
  if (presence) {
    const action = presence[2] || presence[3];
    return {
      serverId,
      timestamp,
      type: action === "joined" ? "join" : "leave",
      player: sanitize(presence[1], 32),
      message: action === "joined" ? "joined the game" : "left the game",
    };
  }

  return null;
}

export function parseLogLine(serverId, line) {
  const cleaned = stripFormatting(line.replaceAll("\u0000", ""));
  const modern = /^\[([^\]]+)\] \[[^\]]+\/INFO\] \[[^\]]+\]: (.+)$/.exec(cleaned);
  if (modern) {
    const timestamp = parseModernTimestamp(modern[1]);
    return timestamp ? classifyMessage(serverId, timestamp, modern[2]) : null;
  }

  const legacy = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[INFO\](?: \[[^\]]+\])?:? (.+)$/.exec(cleaned);
  if (legacy) {
    const parsed = new Date(legacy[1].replace(" ", "T"));
    return Number.isNaN(parsed.getTime()) ? null : classifyMessage(serverId, parsed.toISOString(), legacy[2]);
  }

  return null;
}

function parseLegacyLogin(serverId, line) {
  const cleaned = stripFormatting(line.replaceAll("\u0000", ""));
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) \[INFO\] ([A-Za-z0-9_]{1,32}) \[\/[^\]]+\] logged in with entity id /.exec(
    cleaned,
  );
  if (!match) return null;
  const parsed = new Date(match[1].replace(" ", "T"));
  if (Number.isNaN(parsed.getTime())) return null;
  return {
    serverId,
    timestamp: parsed.toISOString(),
    type: "join",
    player: match[2],
    message: "joined the game",
  };
}

async function readTail(filename, maxBytes = MAX_LOG_BYTES) {
  const handle = await fs.open(filename, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, maxBytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    return buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

export async function readRecentActivity(server, limit = 40) {
  if (!server.logPath) return [];
  try {
    const source = await readTail(server.logPath);
    const lines = source.split(/\r?\n/);
    const events = [];
    const eventKeys = new Set();
    const addEvent = (event) => {
      if (!event) return;
      const key = `${event.timestamp}\u001f${event.type}\u001f${event.player}\u001f${event.message}`;
      if (eventKeys.has(key)) return;
      eventKeys.add(key);
      events.push(event);
    };

    for (let index = 0; index < lines.length; index += 1) {
      addEvent(parseLogLine(server.id, lines[index]));
      if (!server.legacyPing) continue;
      const login = parseLegacyLogin(server.id, lines[index]);
      if (!login) continue;
      const timestampPrefix = stripFormatting(lines[index]).slice(0, 19);
      const nearbyLines = lines
        .slice(index + 1, index + 4)
        .map((line) => stripFormatting(line))
        .filter((line) => line.startsWith(timestampPrefix));
      if (!nearbyLines.some((line) => /\[INFO\] Bad packet id:/.test(line))) addEvent(login);
    }

    return events.slice(-limit);
  } catch {
    return [];
  }
}

function updateLegacyPlayerState(state, line) {
  const cleaned = stripFormatting(line.replaceAll("\u0000", ""));
  const connectedPlayers = /\[INFO\] Connected players:\s*(.*)$/.exec(cleaned);
  if (connectedPlayers) {
    state.players.clear();
    for (const player of connectedPlayers[1].split(",").map((value) => value.trim()).filter(Boolean)) {
      if (/^[A-Za-z0-9_]{1,32}$/.test(player)) state.players.add(player);
    }
    return;
  }

  const version = /\[INFO\] Starting minecraft server version (.+)$/.exec(cleaned);
  if (version) {
    state.players.clear();
    state.version = sanitize(version[1], 80);
    return;
  }

  const login = /\[INFO\] ([A-Za-z0-9_]{1,32}) \[\/[^\]]+\] logged in with entity id /.exec(cleaned);
  if (login) {
    state.players.add(login[1]);
    return;
  }

  const departure = /\[INFO\] ([A-Za-z0-9_]{1,32}) (?:has left the game\.|lost connection)/.exec(cleaned);
  if (departure) state.players.delete(departure[1]);
}

export async function readLegacyPlayerState(filename) {
  const stats = await fs.stat(filename);
  let state = legacyPlayerCaches.get(filename);
  if (!state || stats.size < state.offset) {
    state = { offset: 0, remainder: "", players: new Set(), version: null };
  }

  if (stats.size > state.offset) {
    const handle = await fs.open(filename, "r");
    try {
      const length = stats.size - state.offset;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, state.offset);
      const lines = `${state.remainder}${buffer.toString("utf8")}`.split(/\r?\n/);
      state.remainder = lines.pop() || "";
      for (const line of lines) updateLegacyPlayerState(state, line);
      state.offset = stats.size;
    } finally {
      await handle.close();
    }
  }

  legacyPlayerCaches.set(filename, state);
  return { players: [...state.players].sort(), version: state.version };
}

function parseSystemdProperties(source) {
  return Object.fromEntries(
    source
      .split(/\r?\n/)
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

export async function getServiceStatus(service) {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/systemctl",
      [
        "show",
        service,
        "--no-pager",
        "--property=ActiveState,SubState,MainPID,NRestarts,MemoryCurrent,CPUUsageNSec,ExecMainStartTimestamp",
      ],
      { timeout: 2_000, maxBuffer: 64 * 1024 },
    );
    const values = parseSystemdProperties(stdout);
    const startedAt = Date.parse(values.ExecMainStartTimestamp || "");
    return {
      active: values.ActiveState === "active",
      activeState: values.ActiveState || "unknown",
      subState: values.SubState || "unknown",
      pid: Number.parseInt(values.MainPID || "0", 10),
      restarts: Number.parseInt(values.NRestarts || "0", 10),
      memoryBytes: Number.parseInt(values.MemoryCurrent || "0", 10),
      cpuUsageNs: Number.parseInt(values.CPUUsageNSec || "0", 10),
      startedAt: Number.isNaN(startedAt) ? null : new Date(startedAt).toISOString(),
    };
  } catch {
    return {
      active: false,
      activeState: "unknown",
      subState: "unknown",
      pid: 0,
      restarts: 0,
      memoryBytes: 0,
      cpuUsageNs: 0,
      startedAt: null,
    };
  }
}

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

function decodeVarInt(buffer, offset = 0) {
  let value = 0;
  let shift = 0;
  for (let index = offset; index < buffer.length && index < offset + 5; index += 1) {
    const byte = buffer[index];
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value, bytes: index - offset + 1 };
    shift += 7;
  }
  return null;
}

function encodeString(value) {
  const content = Buffer.from(value, "utf8");
  return Buffer.concat([encodeVarInt(content.length), content]);
}

function flattenDescription(description) {
  if (typeof description === "string") return description;
  if (!description || typeof description !== "object") return "";
  const parts = [];
  if (typeof description.text === "string") parts.push(description.text);
  if (Array.isArray(description.extra)) {
    for (const extra of description.extra) parts.push(flattenDescription(extra));
  }
  return parts.join("");
}

function connectAndRead(port, initialPayload, parseResponse, timeoutMs = 1_800) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks = [];
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(value);
    };

    socket.setTimeout(timeoutMs, () => finish(new Error("Minecraft status query timed out")));
    socket.on("connect", () => socket.write(initialPayload));
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      try {
        const value = parseResponse(Buffer.concat(chunks));
        if (value !== undefined) finish(null, value);
      } catch (error) {
        finish(error);
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("end", () => {
      try {
        const value = parseResponse(Buffer.concat(chunks), true);
        value === undefined ? finish(new Error("Incomplete Minecraft status response")) : finish(null, value);
      } catch (error) {
        finish(error);
      }
    });
  });
}

async function queryModernStatus(port) {
  const handshakeBody = Buffer.concat([
    encodeVarInt(0),
    encodeVarInt(0),
    encodeString("localhost"),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    encodeVarInt(1),
  ]);
  const payload = Buffer.concat([encodeVarInt(handshakeBody.length), handshakeBody, Buffer.from([0x01, 0x00])]);
  const started = performance.now();
  const response = await connectAndRead(port, payload, (buffer) => {
    const packetLength = decodeVarInt(buffer);
    if (!packetLength || buffer.length < packetLength.bytes + packetLength.value) return undefined;
    let offset = packetLength.bytes;
    const packetId = decodeVarInt(buffer, offset);
    if (!packetId || packetId.value !== 0) throw new Error("Unexpected Minecraft status packet");
    offset += packetId.bytes;
    const jsonLength = decodeVarInt(buffer, offset);
    if (!jsonLength) return undefined;
    offset += jsonLength.bytes;
    if (buffer.length < offset + jsonLength.value) return undefined;
    return JSON.parse(buffer.subarray(offset, offset + jsonLength.value).toString("utf8"));
  });

  return {
    online: true,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    version: response.version?.name || null,
    protocol: response.version?.protocol ?? null,
    motd: sanitize(flattenDescription(response.description), 200),
    playersOnline: response.players?.online ?? 0,
    playersMax: response.players?.max ?? null,
    players: Array.isArray(response.players?.sample)
      ? response.players.sample.map((player) => sanitize(player.name || "", 32)).filter(Boolean)
      : [],
  };
}

function decodeUtf16Be(buffer) {
  const swapped = Buffer.from(buffer);
  if (swapped.length % 2 !== 0) return "";
  swapped.swap16();
  return swapped.toString("utf16le");
}

async function queryLegacyStatus(port) {
  const started = performance.now();
  const text = await connectAndRead(port, Buffer.from([0xfe]), (buffer) => {
    if (buffer.length < 3 || buffer[0] !== 0xff) return undefined;
    const characterCount = buffer.readUInt16BE(1);
    if (buffer.length < 3 + characterCount * 2) return undefined;
    return decodeUtf16Be(buffer.subarray(3, 3 + characterCount * 2));
  });

  let version = null;
  let motd = "";
  let playersOnline = 0;
  let playersMax = null;
  if (text.startsWith("§1\u0000")) {
    const fields = text.split("\u0000");
    version = fields[2] || null;
    motd = fields[3] || "";
    playersOnline = Number.parseInt(fields[4] || "0", 10);
    playersMax = Number.parseInt(fields[5] || "0", 10);
  } else {
    const fields = text.split("§");
    motd = fields[0] || "";
    playersOnline = Number.parseInt(fields.at(-2) || "0", 10);
    playersMax = Number.parseInt(fields.at(-1) || "0", 10);
  }

  return {
    online: true,
    latencyMs: Math.max(0, Math.round(performance.now() - started)),
    version,
    protocol: null,
    motd: sanitize(motd, 200),
    playersOnline: Number.isNaN(playersOnline) ? 0 : playersOnline,
    playersMax: Number.isNaN(playersMax) ? null : playersMax,
    players: [],
  };
}

export async function queryMinecraftStatus(port, legacyPreferred = false) {
  const queries = legacyPreferred ? [queryLegacyStatus, queryModernStatus] : [queryModernStatus, queryLegacyStatus];
  let lastError;
  for (const query of queries) {
    try {
      return await query(port);
    } catch (error) {
      lastError = error;
    }
  }
  return { online: false, error: lastError?.message || "Status query failed" };
}

export async function collectDashboardData({
  root = DEFAULT_ROOT,
  manifestRoot = DEFAULT_MANIFEST_ROOT,
  publicHost = "localhost",
  basePath = "/status",
} = {}) {
  const discovered = await discoverServers(root, { manifestRoot });
  const records = await Promise.all(
    discovered.map(async (server) => {
      const [service, activity] = await Promise.all([
        getServiceStatus(server.service),
        readRecentActivity(server),
      ]);
      let ping;
      if (server.legacyPing && server.logPath) {
        const legacyState = await readLegacyPlayerState(server.logPath);
        ping = {
          online: service.active,
          version: legacyState.version,
          motd: server.properties.motd || server.name,
          playersOnline: legacyState.players.length,
          playersMax: null,
          players: legacyState.players,
          latencyMs: null,
        };
      } else {
        ping = await queryMinecraftStatus(server.port);
      }
      const playerProfiles = await collectPlayerProfiles(server, ping.players || [], basePath);
      const playersMax = ping.playersMax ?? (Number.parseInt(server.properties["max-players"] || "0", 10) || null);
      const state = ping.online ? "online" : service.active ? "starting" : "offline";
      return {
        id: server.id,
        name: server.name,
        state,
        service: server.service,
        address: server.port === 25565 ? publicHost : `${publicHost}:${server.port}`,
        port: server.port,
        version: ping.version,
        motd: ping.motd || server.properties.motd || server.name,
        playersOnline: ping.playersOnline ?? 0,
        playersMax,
        players: ping.players || [],
        playerProfiles,
        latencyMs: ping.latencyMs ?? null,
        hasIcon: server.hasIcon,
        iconUrl: server.hasIcon
          ? `${basePath}/api/servers/${encodeURIComponent(server.id)}/icon?v=${server.iconVersion}`
          : null,
        memoryBytes: service.memoryBytes,
        cpuUsageNs: service.cpuUsageNs,
        cpuPercent: calculateLiveCpuPercent(server.service, service.cpuUsageNs),
        startedAt: service.startedAt,
        restarts: service.restarts,
        whitelist: server.properties["white-list"] === "true",
        onlineMode: server.properties["online-mode"] !== "false",
        activity,
      };
    }),
  );

  const activity = records
    .flatMap((server) => server.activity)
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
    .slice(0, 60);

  return {
    generatedAt: new Date().toISOString(),
    servers: records.map(({ activity: serverActivity, ...server }) => ({
      ...server,
      activity: [...serverActivity].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)),
    })),
    activity,
  };
}

export function isValidInstanceId(value) {
  return INSTANCE_PATTERN.test(value);
}
