import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  collectPlayerProfiles,
  isValidUuid,
  normalizeMinecraftTextureUrl,
  parseEssentialsSession,
  parseModernSessionStarts,
} from "../lib/player-profiles.mjs";

test("builds skin URLs from the configured base path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcctl-player-profile-"));
  try {
    await writeFile(
      path.join(directory, "usercache.json"),
      JSON.stringify([{ name: "Alpha", uuid: "689a6522-8e89-4895-89bc-d80a6c8110c8" }]),
    );
    const [profile] = await collectPlayerProfiles(
      { directory, legacyPing: false, logPath: null },
      ["Alpha"],
      "/minecraft",
    );
    assert.equal(profile.skinUrl, "/minecraft/api/players/689a6522-8e89-4895-89bc-d80a6c8110c8/skin");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("tracks modern active session starts", () => {
  const sessions = parseModernSessionStarts(
    [
      "[13Nov2026 20:00:00.000] [Server thread/INFO] [net.minecraft.server.players.PlayerList/]: Alpha[/127.0.0.1:1000] logged in with entity id 1 at (0, 0, 0)",
      "[13Nov2026 20:01:00.000] [Server thread/INFO] [net.minecraft.server.players.PlayerList/]: Beta[/127.0.0.1:1001] logged in with entity id 2 at (0, 0, 0)",
      "[13Nov2026 20:02:00.000] [Server thread/INFO] [net.minecraft.server.MinecraftServer/]: Alpha left the game",
    ].join("\n"),
  );
  assert.equal(sessions.has("alpha"), false);
  assert.equal(sessions.get("beta"), "2026-11-14T04:01:00.000Z");
});

test("reads Essentials online session timestamps", () => {
  assert.deepEqual(parseEssentialsSession("timestamps:\n    login: 2000\n    logout: 1000\n"), {
    login: 2000,
    logout: 1000,
    currentSessionStartedAt: "1970-01-01T00:00:02.000Z",
  });
  assert.equal(parseEssentialsSession("timestamps:\n    login: 1000\n    logout: 2000\n").currentSessionStartedAt, null);
});

test("validates player UUIDs", () => {
  assert.equal(isValidUuid("689a6522-8e89-4895-89bc-d80a6c8110c8"), true);
  assert.equal(isValidUuid("689a65228e89489589bcd80a6c8110c8"), true);
  assert.equal(isValidUuid("../skin"), false);
});

test("accepts only official Minecraft texture URLs and upgrades them to HTTPS", () => {
  assert.equal(
    normalizeMinecraftTextureUrl("http://textures.minecraft.net/texture/abcdef1234"),
    "https://textures.minecraft.net/texture/abcdef1234",
  );
  assert.equal(normalizeMinecraftTextureUrl("https://example.com/texture/abcdef1234"), null);
  assert.equal(normalizeMinecraftTextureUrl("https://textures.minecraft.net.evil.test/texture/abcdef1234"), null);
  assert.equal(normalizeMinecraftTextureUrl("https://textures.minecraft.net/other/abcdef1234"), null);
});
