import assert from "node:assert/strict";
import test from "node:test";
import { compareVersions, parseSpec, requiredJavaMajor, resolveSpec } from "../lib/specs.mjs";

function fakeFetch(routes) {
  return async (url) => {
    const value = routes[url];
    if (value === undefined) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    return {
      ok: true,
      status: 200,
      json: async () => (typeof value === "string" ? JSON.parse(value) : value),
      text: async () => (typeof value === "string" ? value : JSON.stringify(value)),
    };
  };
}

test("parses shorthand and pinned specs", () => {
  assert.deepEqual(parseSpec("latest-fabric"), {
    requested: "latest-fabric",
    minecraftVersion: null,
    latest: true,
    loader: "fabric",
    loaderVersion: null,
  });
  assert.equal(parseSpec("1.12.2-forge").minecraftVersion, "1.12.2");
  assert.equal(parseSpec("26.3-vanilla").minecraftVersion, "26.3");
  assert.equal(parseSpec("1.21.1-neoforge@21.1.224").loaderVersion, "21.1.224");
  assert.throws(() => parseSpec("latest"), /Invalid spec/);
  assert.throws(() => parseSpec("1.21.1-vanilla@x"), /cannot include/);
});

test("maps Minecraft releases to Java requirements", () => {
  assert.equal(requiredJavaMajor("1.12.2"), 8);
  assert.equal(requiredJavaMajor("1.17.1"), 16);
  assert.equal(requiredJavaMajor("1.20.4"), 17);
  assert.equal(requiredJavaMajor("1.20.5"), 21);
  assert.equal(requiredJavaMajor("1.21.1"), 21);
});

test("sorts numeric loader versions", () => {
  assert.ok(compareVersions("21.1.224", "21.1.99") > 0);
  assert.ok(compareVersions("0.16.10", "0.16.9") > 0);
});

test("resolves latest vanilla from Mojang metadata", async () => {
  const manifestUrl = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
  const detailsUrl = "https://example.test/1.21.1.json";
  const resolved = await resolveSpec("latest-vanilla", {
    fetchImpl: fakeFetch({
      [manifestUrl]: {
        latest: { release: "1.21.1" },
        versions: [{ id: "1.21.1", type: "release", url: detailsUrl }],
      },
      [detailsUrl]: { downloads: { server: { url: "https://example.test/server.jar", sha1: "a".repeat(40) } } },
    }),
  });
  assert.equal(resolved.minecraftVersion, "1.21.1");
  assert.equal(resolved.javaMajor, 21);
  assert.equal(resolved.artifact.sha1, "a".repeat(40));
});

test("uses Mojang's declared Java version for year-based releases", async () => {
  const manifestUrl = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
  const detailsUrl = "https://example.test/26.3.json";
  const resolved = await resolveSpec("latest-vanilla", {
    fetchImpl: fakeFetch({
      [manifestUrl]: {
        latest: { release: "26.3" },
        versions: [{ id: "26.3", type: "release", url: detailsUrl }],
      },
      [detailsUrl]: {
        javaVersion: { majorVersion: 25 },
        downloads: { server: { url: "https://example.test/server-26.3.jar", sha1: "d".repeat(40) } },
      },
    }),
  });
  assert.equal(resolved.minecraftVersion, "26.3");
  assert.equal(resolved.javaMajor, 25);
});

test("resolves a stable Fabric combination", async () => {
  const resolved = await resolveSpec("latest-fabric", {
    fetchImpl: fakeFetch({
      "https://meta.fabricmc.net/v2/versions/game": [{ version: "1.21.1", stable: true }],
      "https://meta.fabricmc.net/v2/versions/loader/1.21.1": [
        { loader: { version: "0.16.9", stable: true }, installer: { version: "1.0.1", stable: true } },
      ],
    }),
  });
  assert.equal(resolved.loaderVersion, "0.16.9");
  assert.equal(resolved.installerVersion, "1.0.1");
  assert.match(resolved.artifact.url, /server\/jar$/);
});

test("resolves Fabric's separate installer metadata and year-based Java", async () => {
  const manifestUrl = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
  const detailsUrl = "https://example.test/26.3.json";
  const resolved = await resolveSpec("latest-fabric", {
    fetchImpl: fakeFetch({
      "https://meta.fabricmc.net/v2/versions/game": [{ version: "26.3", stable: true }],
      "https://meta.fabricmc.net/v2/versions/loader/26.3": [{ loader: { version: "0.20.1", stable: true } }],
      "https://meta.fabricmc.net/v2/versions/installer": [{ version: "1.1.2", stable: true }],
      [manifestUrl]: { versions: [{ id: "26.3", type: "release", url: detailsUrl }] },
      [detailsUrl]: { javaVersion: { majorVersion: 25 } },
    }),
  });
  assert.equal(resolved.minecraftVersion, "26.3");
  assert.equal(resolved.loaderVersion, "0.20.1");
  assert.equal(resolved.installerVersion, "1.1.2");
  assert.equal(resolved.javaMajor, 25);
});

test("resolves recommended Forge and verifies published hash", async () => {
  const artifact = "https://maven.minecraftforge.net/net/minecraftforge/forge/1.12.2-14.23.5.2860/forge-1.12.2-14.23.5.2860-installer.jar";
  const resolved = await resolveSpec("1.12.2-forge", {
    fetchImpl: fakeFetch({
      "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json": {
        promos: { "1.12.2-recommended": "14.23.5.2860" },
      },
      [`${artifact}.sha1`]: "b".repeat(40),
    }),
  });
  assert.equal(resolved.loaderVersion, "14.23.5.2860");
  assert.equal(resolved.javaMajor, 8);
  assert.equal(resolved.artifact.url, artifact);
});

test("resolves matching NeoForge Maven versions", async () => {
  const artifact = "https://maven.neoforged.net/releases/net/neoforged/neoforge/21.1.224/neoforge-21.1.224-installer.jar";
  const metadata = "<metadata><versioning><versions><version>21.1.100</version><version>21.1.224</version></versions></versioning></metadata>";
  const resolved = await resolveSpec("1.21.1-neoforge", {
    fetchImpl: fakeFetch({
      "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml": metadata,
      [`${artifact}.sha1`]: "c".repeat(40),
    }),
  });
  assert.equal(resolved.loaderVersion, "21.1.224");
  assert.equal(resolved.artifact.url, artifact);
});
