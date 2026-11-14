import { createReadStream, promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectDashboardData, discoverServers, isValidInstanceId } from "./lib/dashboard.mjs";
import { HistoryStore } from "./lib/history.mjs";
import { getSkinFile, isValidUuid } from "./lib/player-profiles.mjs";

const directory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.join(directory, "public");
const host = process.env.HOST || "127.0.0.1";
const port = Number.parseInt(process.env.PORT || "3010", 10);
const basePath = (process.env.BASE_PATH || "/status").replace(/\/$/, "");
const minecraftRoot = process.env.MINECRAFT_ROOT || "/srv/minecraft";
const publicHost = process.env.PUBLIC_HOST || "localhost";
const legacyInstances = (process.env.LEGACY_INSTANCES || "").split(",").map((value) => value.trim()).filter(isValidInstanceId);
const historyFile = process.env.HISTORY_FILE || path.join(directory, "data", "history.json");
const skinCacheDirectory = process.env.SKIN_CACHE_DIRECTORY || path.join(directory, "data", "skins");
const cacheDurationMs = 5_000;
const historySampleIntervalMs = 5 * 60 * 1000;

const staticFiles = new Map([
  [`${basePath}/`, ["index.html", "text/html; charset=utf-8"]],
  [`${basePath}/app.js`, ["app.js", "text/javascript; charset=utf-8"]],
  [`${basePath}/styles.css`, ["styles.css", "text/css; charset=utf-8"]],
  [`${basePath}/favicon.svg`, ["favicon.svg", "image/svg+xml"]],
  [`${basePath}/fonts/Monocraft.ttf`, ["fonts/Monocraft.ttf", "font/ttf"]],
  [`${basePath}/fonts/Monocraft-LICENSE`, ["fonts/Monocraft-LICENSE", "text/plain; charset=utf-8"]],
  [`${basePath}/vendor/skinview3d/skinview3d.bundle.js`, ["vendor/skinview3d/skinview3d.bundle.js", "text/javascript; charset=utf-8"]],
  [`${basePath}/vendor/skinview3d/LICENSE`, ["vendor/skinview3d/LICENSE", "text/plain; charset=utf-8"]],
]);

let cache = null;
let cacheExpiresAt = 0;
let pendingCollection = null;
const historyStore = new HistoryStore({ filePath: historyFile, sampleIntervalMs: historySampleIntervalMs });

function setSecurityHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=(), usb=()");
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'",
  );
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  response.end(body);
}

async function getDashboardData() {
  if (cache && Date.now() < cacheExpiresAt) return cache;
  if (!pendingCollection) {
    pendingCollection = collectDashboardData({ root: minecraftRoot, publicHost, basePath, legacyInstances })
      .then((value) => {
        cache = value;
        cacheExpiresAt = Date.now() + cacheDurationMs;
        return value;
      })
      .finally(() => {
        pendingCollection = null;
      });
  }
  return pendingCollection;
}

await historyStore.load();

async function sampleHistory() {
  try {
    const data = await getDashboardData();
    await historyStore.record(data.servers);
  } catch (error) {
    console.error("Unable to sample dashboard history", error);
  }
}

await sampleHistory();
const historyInterval = setInterval(sampleHistory, historySampleIntervalMs);
historyInterval.unref();

async function serveStatic(response, filename, contentType, headOnly) {
  const fullPath = path.join(publicDirectory, filename);
  const stats = await fs.stat(fullPath);
  response.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": stats.size,
    "Cache-Control": filename === "index.html" ? "no-store" : "public, max-age=3600",
  });
  if (headOnly) return response.end();
  createReadStream(fullPath).pipe(response);
}

async function serveIcon(response, instanceId, headOnly) {
  if (!isValidInstanceId(instanceId)) return sendJson(response, 404, { error: "Not found" });
  const servers = await discoverServers(minecraftRoot);
  const server = servers.find((entry) => entry.id === instanceId && entry.hasIcon);
  if (!server) return sendJson(response, 404, { error: "Not found" });
  const stats = await fs.stat(server.iconPath);
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": stats.size,
    "Cache-Control": "public, max-age=300",
  });
  if (headOnly) return response.end();
  createReadStream(server.iconPath).pipe(response);
}

async function serveSkin(response, uuid, headOnly) {
  if (!isValidUuid(uuid)) return sendJson(response, 404, { error: "Not found" });
  const filename = await getSkinFile(uuid, skinCacheDirectory);
  if (!filename) return sendJson(response, 404, { error: "Skin unavailable" });
  const stats = await fs.stat(filename);
  response.writeHead(200, {
    "Content-Type": "image/png",
    "Content-Length": stats.size,
    "Cache-Control": "private, max-age=86400",
  });
  if (headOnly) return response.end();
  createReadStream(filename).pipe(response);
}

const server = http.createServer(async (request, response) => {
  setSecurityHeaders(response);
  const method = request.method || "GET";
  const headOnly = method === "HEAD";
  if (method !== "GET" && !headOnly) {
    response.setHeader("Allow", "GET, HEAD");
    return sendJson(response, 405, { error: "Method not allowed" });
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname === "/healthz") {
      return sendJson(response, 200, { status: "ok" });
    }
    if (url.pathname === basePath) {
      response.writeHead(308, { Location: `${basePath}/`, "Cache-Control": "no-store" });
      return response.end();
    }
    if (url.pathname === `${basePath}/api/servers`) {
      return sendJson(response, 200, await getDashboardData());
    }
    if (url.pathname === `${basePath}/api/history`) {
      return sendJson(response, 200, historyStore.snapshot());
    }

    const iconMatch = new RegExp(`^${basePath}/api/servers/([a-z0-9_-]+)/icon$`).exec(url.pathname);
    if (iconMatch) return serveIcon(response, iconMatch[1], headOnly);

    const skinMatch = new RegExp(`^${basePath}/api/players/([0-9a-f-]+)/skin$`, "i").exec(url.pathname);
    if (skinMatch) return serveSkin(response, skinMatch[1], headOnly);

    const staticFile = staticFiles.get(url.pathname);
    if (staticFile) return serveStatic(response, staticFile[0], staticFile[1], headOnly);

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    console.error("Request failed", error);
    return sendJson(response, 500, { error: "Dashboard data unavailable" });
  }
});

server.listen(port, host, () => {
  console.log(`Minecraft dashboard listening on http://${host}:${port}${basePath}/`);
});

function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  clearInterval(historyInterval);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
