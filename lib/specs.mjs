const MOJANG_MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const FABRIC_META = "https://meta.fabricmc.net/v2/versions";
const FORGE_PROMOTIONS = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";
const FORGE_MAVEN = "https://maven.minecraftforge.net/net/minecraftforge/forge";
const NEOFORGE_METADATA = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";
const NEOFORGE_MAVEN = "https://maven.neoforged.net/releases/net/neoforged/neoforge";

const SPEC_PATTERN = /^(latest|\d+\.\d+(?:\.\d+)?)-(vanilla|fabric|forge|neoforge)(?:@([A-Za-z0-9._+-]+))?$/;

export function parseSpec(value) {
  const match = SPEC_PATTERN.exec(value || "");
  if (!match) {
    throw new Error(
      `Invalid spec "${value}". Expected latest-vanilla, latest-fabric, 1.12.2-forge, or 1.21.1-neoforge@21.1.224.`,
    );
  }
  if (match[2] === "vanilla" && match[3]) throw new Error("Vanilla specs cannot include a loader version.");
  return {
    requested: value,
    minecraftVersion: match[1] === "latest" ? null : match[1],
    latest: match[1] === "latest",
    loader: match[2],
    loaderVersion: match[3] || null,
  };
}

function numericParts(value) {
  return value.split(/[^0-9]+/).filter(Boolean).map(Number);
}

export function compareVersions(left, right) {
  const a = numericParts(left);
  const b = numericParts(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] || 0) - (b[index] || 0);
    if (difference) return difference;
  }
  return left.localeCompare(right);
}

export function requiredJavaMajor(minecraftVersion) {
  const [major, minor, patch = 0] = minecraftVersion.split(".").map(Number);
  if (major !== 1 || !Number.isInteger(minor)) throw new Error(`Unsupported Minecraft version: ${minecraftVersion}`);
  if (minor > 20 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 18) return 17;
  if (minor === 17) return 16;
  return 8;
}

function neoforgeMinecraftVersion(loaderVersion) {
  const [minor, patch] = loaderVersion.split(".").map(Number);
  if (!Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`Cannot derive Minecraft version from NeoForge ${loaderVersion}.`);
  }
  return `1.${minor}.${patch}`;
}

function neoforgePrefix(minecraftVersion) {
  const [major, minor, patch] = minecraftVersion.split(".").map(Number);
  if (major !== 1 || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    throw new Error(`NeoForge requires a three-part Minecraft version, received ${minecraftVersion}.`);
  }
  return `${minor}.${patch}.`;
}

async function request(url, fetchImpl, type = "json") {
  const response = await fetchImpl(url, {
    headers: { "User-Agent": "mcctl/0.1 (+https://github.com/rozalily/mcctl)" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Metadata request failed (${response.status}): ${url}`);
  return type === "text" ? response.text() : response.json();
}

async function javaMajorForVersion(minecraftVersion, fetchImpl) {
  try {
    return requiredJavaMajor(minecraftVersion);
  } catch {
    const manifest = await request(MOJANG_MANIFEST, fetchImpl);
    const versionEntry = manifest.versions?.find((entry) => entry.id === minecraftVersion && entry.type === "release");
    if (!versionEntry) throw new Error(`Minecraft release ${minecraftVersion} was not found in Mojang metadata.`);
    const version = await request(versionEntry.url, fetchImpl);
    const javaMajor = version.javaVersion?.majorVersion;
    if (!Number.isInteger(javaMajor)) throw new Error(`Mojang did not declare a Java version for Minecraft ${minecraftVersion}.`);
    return javaMajor;
  }
}

async function resolveVanilla(spec, fetchImpl) {
  const manifest = await request(MOJANG_MANIFEST, fetchImpl);
  const minecraftVersion = spec.minecraftVersion || manifest.latest?.release;
  const versionEntry = manifest.versions?.find((entry) => entry.id === minecraftVersion && entry.type === "release");
  if (!versionEntry) throw new Error(`Minecraft release ${minecraftVersion} was not found in Mojang metadata.`);
  const version = await request(versionEntry.url, fetchImpl);
  const server = version.downloads?.server;
  if (!server?.url || !server.sha1) throw new Error(`Mojang did not publish a server download for ${minecraftVersion}.`);
  const javaMajor = version.javaVersion?.majorVersion;
  return {
    requestedSpec: spec.requested,
    distribution: "vanilla",
    minecraftVersion,
    loaderVersion: null,
    installerVersion: null,
    javaMajor: Number.isInteger(javaMajor) ? javaMajor : requiredJavaMajor(minecraftVersion),
    artifact: { url: server.url, sha1: server.sha1, filename: "server.jar" },
    installKind: "jar",
  };
}

async function resolveFabric(spec, fetchImpl) {
  let minecraftVersion = spec.minecraftVersion;
  if (!minecraftVersion) {
    const games = await request(`${FABRIC_META}/game`, fetchImpl);
    minecraftVersion = games.find((entry) => entry.stable)?.version;
  }
  if (!minecraftVersion) throw new Error("Fabric did not publish a stable Minecraft version.");
  const combinations = await request(`${FABRIC_META}/loader/${encodeURIComponent(minecraftVersion)}`, fetchImpl);
  if (!Array.isArray(combinations) || combinations.length === 0) {
    throw new Error(`Fabric has no loader compatible with Minecraft ${minecraftVersion}.`);
  }
  const selected = spec.loaderVersion
    ? combinations.find((entry) => entry.loader?.version === spec.loaderVersion)
    : combinations.find((entry) => entry.loader?.stable) || combinations[0];
  if (!selected?.loader?.version) {
    throw new Error(`Fabric loader ${spec.loaderVersion || "latest"} is unavailable for Minecraft ${minecraftVersion}.`);
  }
  const loaderVersion = selected.loader.version;
  let installerVersion = selected.installer?.version;
  if (!installerVersion) {
    const installers = await request(`${FABRIC_META}/installer`, fetchImpl);
    installerVersion = installers.find((entry) => entry.stable)?.version || installers[0]?.version;
  }
  if (!installerVersion) throw new Error("Fabric did not publish a server installer version.");
  return {
    requestedSpec: spec.requested,
    distribution: "fabric",
    minecraftVersion,
    loaderVersion,
    installerVersion,
    javaMajor: await javaMajorForVersion(minecraftVersion, fetchImpl),
    artifact: {
      url: `${FABRIC_META}/loader/${encodeURIComponent(minecraftVersion)}/${encodeURIComponent(loaderVersion)}/${encodeURIComponent(installerVersion)}/server/jar`,
      sha1: null,
      filename: "server.jar",
    },
    installKind: "jar",
  };
}

async function resolveForge(spec, fetchImpl) {
  const promotions = await request(FORGE_PROMOTIONS, fetchImpl);
  const promoted = promotions.promos || {};
  let minecraftVersion = spec.minecraftVersion;
  if (!minecraftVersion) {
    const recommended = Object.keys(promoted).filter((key) => key.endsWith("-recommended")).map((key) => key.slice(0, -12));
    const candidates = recommended.length
      ? recommended
      : Object.keys(promoted).filter((key) => key.endsWith("-latest")).map((key) => key.slice(0, -7));
    minecraftVersion = candidates.sort(compareVersions).at(-1);
  }
  if (!minecraftVersion) throw new Error("Forge promotions did not contain a usable Minecraft version.");
  const loaderVersion =
    spec.loaderVersion || promoted[`${minecraftVersion}-recommended`] || promoted[`${minecraftVersion}-latest`];
  if (!loaderVersion) throw new Error(`Forge has no promoted build for Minecraft ${minecraftVersion}. Pin one with @version.`);
  const coordinate = `${minecraftVersion}-${loaderVersion}`;
  const url = `${FORGE_MAVEN}/${coordinate}/forge-${coordinate}-installer.jar`;
  const sha1 = (await request(`${url}.sha1`, fetchImpl, "text")).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(sha1)) throw new Error(`Forge published an invalid SHA-1 for ${coordinate}.`);
  return {
    requestedSpec: spec.requested,
    distribution: "forge",
    minecraftVersion,
    loaderVersion,
    installerVersion: null,
    javaMajor: requiredJavaMajor(minecraftVersion),
    artifact: { url, sha1, filename: "installer.jar" },
    installKind: "forge-installer",
  };
}

async function resolveNeoForge(spec, fetchImpl) {
  const metadata = await request(NEOFORGE_METADATA, fetchImpl, "text");
  const versions = [...metadata.matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]);
  if (!versions.length) throw new Error("NeoForge Maven metadata contained no versions.");
  let minecraftVersion = spec.minecraftVersion;
  let loaderVersion = spec.loaderVersion;
  if (!minecraftVersion) {
    loaderVersion ||= versions.sort(compareVersions).at(-1);
    minecraftVersion = neoforgeMinecraftVersion(loaderVersion);
  } else if (!loaderVersion) {
    const prefix = neoforgePrefix(minecraftVersion);
    loaderVersion = versions.filter((version) => version.startsWith(prefix)).sort(compareVersions).at(-1);
  }
  if (!loaderVersion || !versions.includes(loaderVersion)) {
    throw new Error(`NeoForge ${loaderVersion || "latest"} is unavailable for Minecraft ${minecraftVersion}.`);
  }
  if (!loaderVersion.startsWith(neoforgePrefix(minecraftVersion))) {
    throw new Error(`NeoForge ${loaderVersion} does not match Minecraft ${minecraftVersion}.`);
  }
  const url = `${NEOFORGE_MAVEN}/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`;
  const sha1 = (await request(`${url}.sha1`, fetchImpl, "text")).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(sha1)) throw new Error(`NeoForge published an invalid SHA-1 for ${loaderVersion}.`);
  return {
    requestedSpec: spec.requested,
    distribution: "neoforge",
    minecraftVersion,
    loaderVersion,
    installerVersion: null,
    javaMajor: requiredJavaMajor(minecraftVersion),
    artifact: { url, sha1, filename: "installer.jar" },
    installKind: "neoforge-installer",
  };
}

export async function resolveSpec(value, { fetchImpl = fetch } = {}) {
  const spec = parseSpec(value);
  switch (spec.loader) {
    case "vanilla":
      return resolveVanilla(spec, fetchImpl);
    case "fabric":
      return resolveFabric(spec, fetchImpl);
    case "forge":
      return resolveForge(spec, fetchImpl);
    case "neoforge":
      return resolveNeoForge(spec, fetchImpl);
    default:
      throw new Error(`Unsupported loader: ${spec.loader}`);
  }
}

export const metadataUrls = {
  mojang: MOJANG_MANIFEST,
  fabric: FABRIC_META,
  forge: FORGE_PROMOTIONS,
  neoforge: NEOFORGE_METADATA,
};
