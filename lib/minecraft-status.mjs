import { promises as fs } from "node:fs";
import net from "node:net";
import { performance } from "node:perf_hooks";

const MAX_LEGACY_LOG_BYTES = 2 * 1024 * 1024;

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

function connectAndRead(port, initialPayload, parseResponse, timeoutMs = 1_500) {
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

async function queryModernPlayerCount(port) {
  const handshakeBody = Buffer.concat([
    encodeVarInt(0),
    encodeVarInt(0),
    encodeString("localhost"),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    encodeVarInt(1),
  ]);
  const payload = Buffer.concat([encodeVarInt(handshakeBody.length), handshakeBody, Buffer.from([0x01, 0x00])]);
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
    online: Number.isInteger(response.players?.online) ? response.players.online : 0,
    max: Number.isInteger(response.players?.max) ? response.players.max : null,
    version: typeof response.version?.name === "string" ? response.version.name : null,
  };
}

function decodeUtf16Be(buffer) {
  const swapped = Buffer.from(buffer);
  if (swapped.length % 2 !== 0) return "";
  swapped.swap16();
  return swapped.toString("utf16le");
}

async function queryLegacyPlayerCount(port) {
  const text = await connectAndRead(port, Buffer.from([0xfe]), (buffer) => {
    if (buffer.length < 3 || buffer[0] !== 0xff) return undefined;
    const characterCount = buffer.readUInt16BE(1);
    if (buffer.length < 3 + characterCount * 2) return undefined;
    return decodeUtf16Be(buffer.subarray(3, 3 + characterCount * 2));
  });
  const fields = text.startsWith("§1\u0000") ? text.split("\u0000") : text.split("§");
  const onlineIndex = text.startsWith("§1\u0000") ? 4 : fields.length - 2;
  const maxIndex = text.startsWith("§1\u0000") ? 5 : fields.length - 1;
  const online = Number.parseInt(fields[onlineIndex] || "0", 10);
  const max = Number.parseInt(fields[maxIndex] || "", 10);
  return {
    online: Number.isNaN(online) ? 0 : online,
    max: Number.isNaN(max) ? null : max,
    version: text.startsWith("§1\u0000") ? fields[2] || null : null,
  };
}

export async function readLegacyPlayerCount(filename, max = null) {
  const handle = await fs.open(filename, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, MAX_LEGACY_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    const players = new Set();
    let hasSnapshot = false;
    let version = null;
    for (const rawLine of buffer.toString("utf8").split(/\r?\n/)) {
      const line = rawLine
        .replaceAll("\u0000", "")
        .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
        .replace(/§[0-9a-fk-or]/gi, "");
      const versionMatch = /Starting minecraft server version (.+)$/.exec(line);
      if (versionMatch) version = versionMatch[1].trim();
      const snapshot = /\[INFO\] Connected players:\s*(.*)$/.exec(line);
      if (snapshot) {
        players.clear();
        for (const player of snapshot[1].split(",").map((value) => value.trim()).filter(Boolean)) players.add(player);
        hasSnapshot = true;
        continue;
      }
      if (!hasSnapshot) continue;
      const login = /\[INFO\] ([A-Za-z0-9_]{1,32}) \[\/[^\]]+\] logged in with entity id /.exec(line);
      if (login) players.add(login[1]);
      const leave = /\[INFO\] ([A-Za-z0-9_]{1,32}) (?:has left the game\.|lost connection:)/.exec(line);
      if (leave) players.delete(leave[1]);
    }
    return hasSnapshot ? { online: players.size, max, version } : null;
  } finally {
    await handle.close();
  }
}

export async function readLoggedVersion(filename) {
  const handle = await fs.open(filename, "r");
  try {
    const stats = await handle.stat();
    const length = Math.min(stats.size, MAX_LEGACY_LOG_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, Math.max(0, stats.size - length));
    let matches = [...buffer.toString("utf8").matchAll(/Starting minecraft server version ([^\r\n]+)/g)];
    if (matches.length === 0 && stats.size > length) {
      const head = Buffer.alloc(Math.min(stats.size, 256 * 1024));
      await handle.read(head, 0, head.length, 0);
      matches = [...head.toString("utf8").matchAll(/Starting minecraft server version ([^\r\n]+)/g)];
    }
    return matches.at(-1)?.[1]?.trim() || null;
  } finally {
    await handle.close();
  }
}

export async function queryPlayerCount(port, { legacyLogPath = null, maxPlayers = null } = {}) {
  const started = performance.now();
  if (legacyLogPath) {
    const legacyCount = await readLegacyPlayerCount(legacyLogPath, maxPlayers).catch(() => null);
    if (legacyCount) return { ...legacyCount, latencyMs: 0 };
  }
  let lastError;
  for (const query of [queryModernPlayerCount, queryLegacyPlayerCount]) {
    try {
      return { ...(await query(port)), latencyMs: Math.max(0, Math.round(performance.now() - started)) };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Minecraft status query failed");
}
