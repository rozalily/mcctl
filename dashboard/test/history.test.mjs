import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { HistoryStore } from "../lib/history.mjs";

function server({ cpuUsageNs, playersOnline = 1, memoryBytes = 1024, state = "online" }) {
  return { id: "modern", cpuUsageNs, playersOnline, memoryBytes, state };
}

test("records, deduplicates, persists, and prunes telemetry", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "minecraft-history-"));
  const filePath = path.join(directory, "history.json");
  const start = Date.UTC(2026, 10, 13, 12, 0, 0);
  try {
    const history = new HistoryStore({ filePath, retentionMs: 60 * 60 * 1000, sampleIntervalMs: 5 * 60 * 1000 });
    await history.load(start);
    await history.record([server({ cpuUsageNs: 100_000_000_000 })], start);
    await history.record([server({ cpuUsageNs: 110_000_000_000, playersOnline: 2 })], start + 60_000);
    assert.equal(history.snapshot(start + 60_000).servers.modern.length, 1);

    await history.record(
      [server({ cpuUsageNs: 160_000_000_000, playersOnline: 3, memoryBytes: 2048 })],
      start + 5 * 60_000,
    );
    const points = history.snapshot(start + 5 * 60_000).servers.modern;
    assert.equal(points.length, 2);
    assert.equal(points[0].cpuPercent, null);
    assert.equal(points[1].cpuPercent, 20);
    assert.equal(points[1].players, 3);
    assert.equal(points[1].memoryBytes, 2048);
    assert.equal("cpuUsageNs" in history.snapshot(start + 5 * 60_000).servers.modern[1], false);

    const restored = new HistoryStore({ filePath, retentionMs: 60 * 60 * 1000, sampleIntervalMs: 5 * 60 * 1000 });
    await restored.load(start + 5 * 60_000);
    assert.equal(restored.snapshot(start + 5 * 60_000).servers.modern.length, 2);

    await restored.record([server({ cpuUsageNs: 220_000_000_000 })], start + 10 * 60_000);
    assert.equal(restored.snapshot(start + 10 * 60_000).servers.modern.at(-1).cpuPercent, 20);

    await restored.record([server({ cpuUsageNs: 300_000_000_000 })], start + 75 * 60_000);
    const pruned = restored.snapshot(start + 75 * 60_000).servers.modern;
    assert.equal(pruned.length, 1);
    assert.ok(pruned[0].cpuPercent > 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
