import { promises as fs } from "node:fs";
import path from "node:path";

const FILE_VERSION = 1;

function finiteNumber(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function validPoint(point) {
  return (
    point &&
    typeof point.timestamp === "string" &&
    Number.isFinite(Date.parse(point.timestamp)) &&
    Number.isFinite(point.players) &&
    Number.isFinite(point.memoryBytes) &&
    (point.cpuUsageNs === undefined || Number.isFinite(point.cpuUsageNs)) &&
    (point.cpuPercent === null || Number.isFinite(point.cpuPercent)) &&
    typeof point.state === "string"
  );
}

export class HistoryStore {
  constructor({ filePath, retentionMs = 24 * 60 * 60 * 1000, sampleIntervalMs = 5 * 60 * 1000 }) {
    this.filePath = filePath;
    this.retentionMs = retentionMs;
    this.sampleIntervalMs = sampleIntervalMs;
    this.servers = {};
    this.cpuBaselines = new Map();
  }

  async load(now = Date.now()) {
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, "utf8"));
      if (parsed.version !== FILE_VERSION || !parsed.servers || typeof parsed.servers !== "object") return;
      this.servers = Object.fromEntries(
        Object.entries(parsed.servers).map(([serverId, points]) => [
          serverId,
          Array.isArray(points) ? points.filter(validPoint) : [],
        ]),
      );
      this.prune(now);
      for (const [serverId, points] of Object.entries(this.servers)) {
        const latest = points.at(-1);
        if (latest && Number.isFinite(latest.cpuUsageNs)) {
          this.cpuBaselines.set(serverId, {
            timestamp: Date.parse(latest.timestamp),
            cpuUsageNs: latest.cpuUsageNs,
          });
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") console.error("Unable to load dashboard history", error);
    }
  }

  prune(now = Date.now()) {
    const cutoff = now - this.retentionMs;
    for (const [serverId, points] of Object.entries(this.servers)) {
      this.servers[serverId] = points.filter((point) => Date.parse(point.timestamp) >= cutoff);
      if (this.servers[serverId].length === 0) delete this.servers[serverId];
    }
  }

  calculateCpuPercent(server, now) {
    const currentCpuNs = finiteNumber(server.cpuUsageNs);
    const previous = this.cpuBaselines.get(server.id);
    this.cpuBaselines.set(server.id, { timestamp: now, cpuUsageNs: currentCpuNs });
    if (!previous || currentCpuNs < previous.cpuUsageNs || now <= previous.timestamp) return null;
    const elapsedNs = (now - previous.timestamp) * 1_000_000;
    return Math.max(0, ((currentCpuNs - previous.cpuUsageNs) / elapsedNs) * 100);
  }

  async record(servers, now = Date.now()) {
    let changed = false;
    for (const server of servers) {
      const points = (this.servers[server.id] ??= []);
      const previousTimestamp = points.length ? Date.parse(points.at(-1).timestamp) : 0;
      if (previousTimestamp && now - previousTimestamp < this.sampleIntervalMs * 0.9) {
        if (!this.cpuBaselines.has(server.id)) {
          this.cpuBaselines.set(server.id, { timestamp: now, cpuUsageNs: finiteNumber(server.cpuUsageNs) });
        }
        continue;
      }

      const cpuPercent = this.calculateCpuPercent(server, now);

      points.push({
        timestamp: new Date(now).toISOString(),
        players: Math.max(0, Math.round(finiteNumber(server.playersOnline))),
        memoryBytes: Math.max(0, Math.round(finiteNumber(server.memoryBytes))),
        cpuUsageNs: Math.max(0, Math.round(finiteNumber(server.cpuUsageNs))),
        cpuPercent: cpuPercent === null ? null : Number(cpuPercent.toFixed(2)),
        state: typeof server.state === "string" ? server.state : "unknown",
      });
      changed = true;
    }

    this.prune(now);
    if (changed) await this.persist();
  }

  snapshot(now = Date.now()) {
    this.prune(now);
    return {
      generatedAt: new Date(now).toISOString(),
      retentionMs: this.retentionMs,
      sampleIntervalMs: this.sampleIntervalMs,
      servers: Object.fromEntries(
        Object.entries(this.servers).map(([serverId, points]) => [
          serverId,
          points.map(({ cpuUsageNs: _cpuUsageNs, ...point }) => ({ ...point })),
        ]),
      ),
    };
  }

  async persist() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const body = `${JSON.stringify({ version: FILE_VERSION, servers: this.servers })}\n`;
    await fs.writeFile(temporaryPath, body, { mode: 0o600 });
    await fs.rename(temporaryPath, this.filePath);
  }
}
