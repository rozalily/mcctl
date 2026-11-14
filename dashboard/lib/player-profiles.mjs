import { promises as fs } from "node:fs";
import path from "node:path";

const PLAYER_NAME = /^[A-Za-z0-9_]{1,32}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const SKIN_CACHE_MS = 24 * 60 * 60 * 1000;

async function readJson(filename) {
  try {
    return JSON.parse(await fs.readFile(filename, "utf8"));
  } catch {
    return null;
  }
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

export function parseModernSessionStarts(source) {
  const sessions = new Map();
  for (const line of source.split(/\r?\n/)) {
    const login = /^\[([^\]]+)\] \[[^\]]+\/INFO\] \[[^\]]*PlayerList\/\]: ([A-Za-z0-9_]{1,32})\[\/[^\]]+\] logged in with entity id /.exec(
      line,
    );
    if (login) {
      const timestamp = parseModernTimestamp(login[1]);
      if (timestamp) sessions.set(login[2].toLowerCase(), timestamp);
      continue;
    }
    const leave = /^\[[^\]]+\] \[[^\]]+\/INFO\] \[[^\]]*MinecraftServer\/\]: ([A-Za-z0-9_]{1,32}) left the game$/.exec(line);
    if (leave) sessions.delete(leave[1].toLowerCase());
  }
  return sessions;
}

export function parseEssentialsSession(source) {
  const timestamps = /(?:^|\n)timestamps:\s*\n((?:\s{2,}.+\n?)*)/.exec(source)?.[1] || "";
  const login = Number.parseInt(/(?:^|\n)\s+login:\s*(\d+)/.exec(`\n${timestamps}`)?.[1] || "0", 10);
  const logout = Number.parseInt(/(?:^|\n)\s+logout:\s*(\d+)/.exec(`\n${timestamps}`)?.[1] || "0", 10);
  return {
    login,
    logout,
    currentSessionStartedAt: login > logout ? new Date(login).toISOString() : null,
  };
}

async function uuidMap(server) {
  const filename = path.join(server.directory, server.legacyPing ? "uuidcache.json" : "usercache.json");
  const entries = await readJson(filename);
  const result = new Map();
  if (!Array.isArray(entries)) return result;
  for (const entry of entries) {
    if (typeof entry?.name === "string" && typeof entry?.uuid === "string" && UUID.test(entry.uuid)) {
      result.set(entry.name.toLowerCase(), entry.uuid.toLowerCase());
    }
  }
  return result;
}

async function modernTotalPlaytime(server, uuid, currentSessionStartedAt) {
  const filename = path.join(server.directory, "world", "stats", `${uuid}.json`);
  const stats = await readJson(filename);
  const ticks = stats?.stats?.["minecraft:custom"]?.["minecraft:play_time"];
  if (!Number.isFinite(ticks)) return null;
  let seconds = Math.max(0, ticks / 20);
  if (currentSessionStartedAt) {
    try {
      const fileStats = await fs.stat(filename);
      const sessionStartedAt = Date.parse(currentSessionStartedAt);
      const accountedThrough = Math.max(fileStats.mtimeMs, Number.isFinite(sessionStartedAt) ? sessionStartedAt : 0);
      seconds += Math.max(0, (Date.now() - accountedThrough) / 1000);
    } catch {
      // The persisted value is still useful.
    }
  }
  return Math.floor(seconds);
}

async function modernSessions(server) {
  if (!server.logPath) return new Map();
  try {
    return parseModernSessionStarts(await fs.readFile(server.logPath, "utf8"));
  } catch {
    return new Map();
  }
}

async function legacySession(server, name) {
  if (!PLAYER_NAME.test(name)) return null;
  try {
    const source = await fs.readFile(
      path.join(server.directory, "plugins", "Essentials", "userdata", `${name.toLowerCase()}.yml`),
      "utf8",
    );
    return parseEssentialsSession(source).currentSessionStartedAt;
  } catch {
    return null;
  }
}

export async function collectPlayerProfiles(server, players, basePath = "/status") {
  const uuids = await uuidMap(server);
  const sessions = server.legacyPing ? null : await modernSessions(server);
  return Promise.all(
    players.map(async (name) => {
      const uuid = uuids.get(name.toLowerCase()) || null;
      const currentSessionStartedAt = server.legacyPing
        ? await legacySession(server, name)
        : sessions.get(name.toLowerCase()) || null;
      const totalPlaytimeSeconds =
        !server.legacyPing && uuid ? await modernTotalPlaytime(server, uuid, currentSessionStartedAt) : null;
      return {
        name,
        uuid,
        currentSessionStartedAt,
        totalPlaytimeSeconds,
        skinUrl: uuid ? `${basePath}/api/players/${uuid}/skin` : null,
      };
    }),
  );
}

export function normalizeMinecraftTextureUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.hostname !== "textures.minecraft.net" ||
      !/^\/texture\/[0-9a-f]+$/i.test(url.pathname) ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    url.protocol = "https:";
    return url.toString();
  } catch {
    return null;
  }
}

export async function getSkinFile(uuid, cacheDirectory) {
  if (!UUID.test(uuid)) return null;
  const compactUuid = uuid.replaceAll("-", "").toLowerCase();
  const filename = path.join(cacheDirectory, `${compactUuid}.png`);
  try {
    const stats = await fs.stat(filename);
    if (Date.now() - stats.mtimeMs < SKIN_CACHE_MS) return filename;
  } catch {
    // Fetch below.
  }

  const profileResponse = await fetch(`https://sessionserver.mojang.com/session/minecraft/profile/${compactUuid}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!profileResponse.ok) return null;
  const profile = await profileResponse.json();
  const textureProperty = profile.properties?.find((property) => property.name === "textures" && property.value);
  if (!textureProperty) return null;
  const textures = JSON.parse(Buffer.from(textureProperty.value, "base64").toString("utf8"));
  const textureUrl = normalizeMinecraftTextureUrl(textures?.textures?.SKIN?.url);
  if (!textureUrl) return null;

  const skinResponse = await fetch(textureUrl, { signal: AbortSignal.timeout(8_000) });
  if (!skinResponse.ok || !skinResponse.headers.get("content-type")?.startsWith("image/png")) return null;
  const skin = Buffer.from(await skinResponse.arrayBuffer());
  if (skin.length === 0 || skin.length > 1024 * 1024) return null;
  await fs.mkdir(cacheDirectory, { recursive: true });
  const temporary = `${filename}.${process.pid}.tmp`;
  await fs.writeFile(temporary, skin, { mode: 0o600 });
  await fs.rename(temporary, filename);
  return filename;
}

export function isValidUuid(value) {
  return UUID.test(value);
}
