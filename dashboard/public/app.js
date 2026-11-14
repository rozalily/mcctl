const refreshButton = document.querySelector("#refresh");
const updatedAt = document.querySelector("#updated-at");
const serverList = document.querySelector("#server-list");
const errorMessage = document.querySelector("#error-message");
const apiBase = new URL("api/", document.baseURI);

let dashboardData = null;
let historyData = { servers: {} };
let refreshing = false;
const serverPanels = new Map();
const panelReferences = new WeakMap();
const playerProfiles = new Map();
let playerPopover = null;
let activePlayerProfile = null;
let skinViewer = null;
let skinLoadGeneration = 0;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const power = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** power).toFixed(power >= 3 ? 1 : 0)} ${units[power]}`;
}

function formatDuration(startedAt) {
  if (!startedAt) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1000));
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function relativeTime(timestamp) {
  const seconds = Math.round((Date.parse(timestamp) - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function formatPlaytime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "Unavailable";
  const totalMinutes = Math.floor(seconds / 60);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function ensurePlayerPopover() {
  if (playerPopover) return playerPopover;
  const popover = element("div", "player-popover");
  popover.id = "player-profile-popover";
  popover.role = "tooltip";
  popover.hidden = true;
  const canvas = element("canvas", "player-skin");
  const details = element("div", "player-popover__details");
  const name = element("strong", "player-popover__name");
  const sessionLabel = element("span", "player-popover__label", "Current session");
  const session = element("span", "player-popover__value");
  session.dataset.session = "";
  const totalLabel = element("span", "player-popover__label", "Total playtime");
  const total = element("span", "player-popover__value");
  total.dataset.total = "";
  details.append(name, sessionLabel, session, totalLabel, total);
  popover.append(canvas, details);
  document.body.append(popover);
  playerPopover = popover;
  return popover;
}

function ensureSkinViewer(canvas) {
  if (skinViewer) return skinViewer;
  if (!window.skinview3d?.SkinViewer) throw new Error("3D skin renderer unavailable");
  skinViewer = new window.skinview3d.SkinViewer({
    canvas,
    width: 112,
    height: 176,
    pixelRatio: Math.min(Math.max(window.devicePixelRatio || 1, 2), 3),
    background: 0x242328,
    enableControls: false,
    fov: 50,
    zoom: 0.72,
    renderPaused: true,
  });
  skinViewer.autoRotate = !reducedMotion.matches;
  skinViewer.autoRotateSpeed = 0.35;
  skinViewer.fxaaPass.enabled = false;
  skinViewer.globalLight.intensity = 2.4;
  skinViewer.cameraLight.intensity = 0.7;
  return skinViewer;
}

async function loadPlayerModel(canvas, profile) {
  const generation = ++skinLoadGeneration;
  canvas.classList.remove("player-skin--unavailable");
  let viewer;
  try {
    viewer = ensureSkinViewer(canvas);
  } catch {
    canvas.classList.add("player-skin--unavailable");
    return;
  }
  viewer.renderPaused = false;
  viewer.autoRotate = !reducedMotion.matches;
  viewer.loadSkin(null);
  if (!profile.skinUrl) {
    canvas.classList.add("player-skin--unavailable");
    return;
  }
  try {
    await viewer.loadSkin(profile.skinUrl);
  } catch {
    if (generation === skinLoadGeneration) canvas.classList.add("player-skin--unavailable");
    return;
  }
  if (generation !== skinLoadGeneration && activePlayerProfile?.skinUrl) {
    viewer.loadSkin(activePlayerProfile.skinUrl).catch(() => canvas.classList.add("player-skin--unavailable"));
  }
}

function updatePlayerPopoverTime() {
  if (!playerPopover || playerPopover.hidden || !activePlayerProfile) return;
  const startedAt = Date.parse(activePlayerProfile.currentSessionStartedAt || "");
  const elapsed = Number.isFinite(startedAt) ? Math.max(0, (Date.now() - startedAt) / 1000) : null;
  playerPopover.querySelector("[data-session]").textContent = formatPlaytime(elapsed);
}

function showPlayerPopover(chip, profileKey) {
  const profile = playerProfiles.get(profileKey);
  if (!profile) return;
  const popover = ensurePlayerPopover();
  activePlayerProfile = profile;
  popover.querySelector(".player-popover__name").textContent = profile.name;
  popover.querySelector("[data-total]").textContent = formatPlaytime(profile.totalPlaytimeSeconds);
  popover.hidden = false;
  updatePlayerPopoverTime();
  loadPlayerModel(popover.querySelector("canvas"), profile);
  const chipBounds = chip.getBoundingClientRect();
  const popoverBounds = popover.getBoundingClientRect();
  let left = chipBounds.left + chipBounds.width / 2 - popoverBounds.width / 2;
  left = Math.max(8, Math.min(window.innerWidth - popoverBounds.width - 8, left));
  let top = chipBounds.bottom + 8;
  if (top + popoverBounds.height > window.innerHeight - 8) top = chipBounds.top - popoverBounds.height - 8;
  popover.style.left = `${Math.max(8, left)}px`;
  popover.style.top = `${Math.max(8, top)}px`;
}

function hidePlayerPopover() {
  if (!playerPopover) return;
  playerPopover.hidden = true;
  activePlayerProfile = null;
  skinLoadGeneration += 1;
  if (skinViewer) skinViewer.renderPaused = true;
}

reducedMotion.addEventListener("change", () => {
  if (skinViewer) skinViewer.autoRotate = !reducedMotion.matches;
});

document.addEventListener("visibilitychange", () => {
  if (skinViewer) skinViewer.renderPaused = document.hidden || !playerPopover || playerPopover.hidden;
});

function formatCpu(value) {
  return Number.isFinite(value) ? `${value.toFixed(value >= 10 ? 0 : 1)}%` : "Collecting";
}

function formatTrendValue(metric, value) {
  if (metric === "players") return `${Math.round(value)} player${Math.round(value) === 1 ? "" : "s"}`;
  if (metric === "memoryBytes") return value === 0 ? "0 GiB" : formatBytes(value);
  return formatCpu(value);
}

function formatTrendTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function createSvgElement(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}

function drawTrend(chart, points, metric, color) {
  const svg = chart.querySelector("svg");
  svg.replaceChildren();
  const values = points
    .map((point) => ({ timestamp: Date.parse(point.timestamp), value: point[metric] }))
    .filter((point) => Number.isFinite(point.timestamp) && Number.isFinite(point.value));
  const now = Date.now();
  const start = now - (historyData.retentionMs || 24 * 60 * 60 * 1000);
  const width = 320;
  const height = 88;
  const padding = 8;

  for (const y of [padding, height / 2, height - padding]) {
    svg.append(createSvgElement("line", { x1: 0, y1: y, x2: width, y2: y, class: "trend-gridline" }));
  }
  if (!values.length) {
    const zeroLabel = createSvgElement("text", { x: 4, y: height - 2, class: "trend-axis-label" });
    zeroLabel.textContent = formatTrendValue(metric, 0);
    svg.append(zeroLabel);
    return;
  }

  const minimum = 0;
  let maximum = Math.max(...values.map((point) => point.value));
  maximum = maximum > 0 ? maximum * 1.08 : 1;

  const maximumLabel = createSvgElement("text", { x: 4, y: 10, class: "trend-axis-label" });
  maximumLabel.textContent = formatTrendValue(metric, maximum);
  const minimumLabel = createSvgElement("text", { x: 4, y: height - 2, class: "trend-axis-label" });
  minimumLabel.textContent = formatTrendValue(metric, minimum);
  svg.append(maximumLabel, minimumLabel);

  const coordinate = (point) => {
    const x = Math.max(0, Math.min(width, ((point.timestamp - start) / (now - start)) * width));
    const y = height - padding - ((point.value - minimum) / (maximum - minimum)) * (height - padding * 2);
    return [x, y];
  };
  const coordinates = values.map(coordinate);
  if (coordinates.length > 1) {
    const area = [
      `M ${coordinates[0][0]} ${height - padding}`,
      ...coordinates.map(([x, y]) => `L ${x} ${y}`),
      `L ${coordinates.at(-1)[0]} ${height - padding}`,
      "Z",
    ].join(" ");
    svg.append(createSvgElement("path", { d: area, fill: color, class: "trend-area" }));
    svg.append(
      createSvgElement("path", {
        d: coordinates.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" "),
        stroke: color,
        class: "trend-line",
      }),
    );
  }
  coordinates.forEach(([x, y], index) => {
    const sample = createSvgElement("circle", { cx: x, cy: y, r: 1.8, fill: color, class: "trend-sample-point" });
    const hitTarget = createSvgElement("circle", {
      cx: x,
      cy: y,
      r: 7,
      class: "trend-hit-target",
      tabindex: 0,
      "aria-label": `${formatTrendTime(values[index].timestamp)}: ${formatTrendValue(metric, values[index].value)}`,
    });
    const title = createSvgElement("title");
    title.textContent = `${formatTrendTime(values[index].timestamp)} · ${formatTrendValue(metric, values[index].value)}`;
    hitTarget.append(title);
    svg.append(sample, hitTarget);
  });
  const [lastX, lastY] = coordinates.at(-1);
  svg.append(createSvgElement("circle", { cx: lastX, cy: lastY, r: 3.2, fill: color, class: "trend-point" }));
}

function createMetadata(label, field) {
  const item = element("div", "server-meta__item");
  const value = element("strong", "", "—");
  value.dataset.field = field;
  item.append(element("span", "server-meta__label", label), value);
  return item;
}

function createTrend(label, metric, color) {
  const trend = element("div", "trend");
  trend.dataset.metric = metric;
  const heading = element("div", "trend__heading");
  const value = element("strong", "trend__value", "—");
  heading.append(element("span", "trend__label", label), value);
  const chart = element("div", "trend__chart");
  const svg = createSvgElement("svg", {
    viewBox: "0 0 320 88",
    preserveAspectRatio: "none",
    role: "img",
    "aria-label": `${label} over the last 24 hours`,
  });
  chart.append(svg);
  trend.append(heading, chart);
  return { trend, value, chart, metric, color };
}

function createServerPanel(server, index) {
  const panel = element("article", "server-panel");
  panel.dataset.serverId = server.id;
  panel.style.animationDelay = `${Math.min(index * 70, 280)}ms`;

  const header = element("header", "server-panel__header");
  const identity = element("div", "server-identity");
  if (server.iconUrl) {
    const icon = element("img", "server-icon");
    icon.src = server.iconUrl;
    icon.alt = `${server.name} server icon`;
    icon.width = 72;
    icon.height = 72;
    identity.append(icon);
  } else {
    identity.append(element("div", "server-icon-fallback", server.name.slice(0, 1).toUpperCase()));
  }

  const identityText = element("div", "server-identity__text");
  const titleRow = element("div", "server-title-row");
  const title = element("h2", "", server.name);
  const status = element("span", "server-status");
  const statusDot = element("span", "status-dot");
  const statusText = element("span", "server-status__text");
  status.append(statusDot, statusText);
  titleRow.append(title, status);
  const address = element("code", "server-address");
  const motd = element("p", "server-motd");
  identityText.append(titleRow, address, motd);
  identity.append(identityText);

  const metadata = element("div", "server-meta");
  metadata.append(createMetadata("Version", "version"), createMetadata("Uptime", "uptime"));
  header.append(identity, metadata);

  const body = element("div", "server-panel__body");
  const playersSection = element("section", "server-section server-players");
  const playersHeading = element("div", "server-section__heading");
  playersHeading.append(element("h3", "", "Players"), element("span", "section-count"));
  const players = element("div", "players");
  playersSection.append(playersHeading, players);

  const activitySection = element("section", "server-section server-activity");
  const activityHeading = element("div", "server-section__heading");
  activityHeading.append(element("h3", "", "Recent activity"), element("span", "section-count"));
  const activity = element("ol", "activity-list");
  activitySection.append(activityHeading, activity);
  body.append(playersSection, activitySection);

  const telemetry = element("section", "server-telemetry");
  const telemetryHeading = element("div", "server-section__heading");
  telemetryHeading.append(element("h3", "", "24-hour trends"), element("span", "section-count", "5-minute samples"));
  const trendGrid = element("div", "trend-grid");
  const trends = {
    players: createTrend("Players · count", "players", "#ee3d43"),
    memory: createTrend("Memory · GiB", "memoryBytes", "#7bc5e8"),
    cpu: createTrend("CPU · % of one core", "cpuPercent", "#ffbe5c"),
  };
  trendGrid.append(...Object.values(trends).map((entry) => entry.trend));
  telemetry.append(telemetryHeading, trendGrid);
  panel.append(header, body, telemetry);

  panelReferences.set(panel, {
    statusDot,
    statusText,
    address,
    motd,
    metadata: Object.fromEntries([...metadata.querySelectorAll("[data-field]")].map((node) => [node.dataset.field, node])),
    players,
    playersCount: playersHeading.querySelector(".section-count"),
    activity,
    activityCount: activityHeading.querySelector(".section-count"),
    historyCount: telemetryHeading.querySelector(".section-count"),
    trends,
  });
  return panel;
}

function updatePlayers(references, server) {
  const profilePrefix = `${server.id}:`;
  for (const key of playerProfiles.keys()) if (key.startsWith(profilePrefix)) playerProfiles.delete(key);
  for (const profile of server.playerProfiles || []) {
    playerProfiles.set(`${profilePrefix}${profile.name.toLowerCase()}`, profile);
  }
  const signature = JSON.stringify([server.playersOnline, server.players]);
  if (references.players.dataset.signature === signature) return;
  references.players.dataset.signature = signature;
  references.players.replaceChildren();
  references.playersCount.textContent = `${server.playersOnline}/${server.playersMax ?? "—"} online`;
  if (server.players.length) {
    for (const player of server.players) {
      const profileKey = `${profilePrefix}${player.toLowerCase()}`;
      const profile = playerProfiles.get(profileKey);
      if (!profile) {
        references.players.append(element("span", "player-chip", player));
        continue;
      }
      const chip = element("button", "player-chip", player);
      chip.type = "button";
      chip.setAttribute("aria-describedby", "player-profile-popover");
      chip.addEventListener("pointerenter", () => showPlayerPopover(chip, profileKey));
      chip.addEventListener("pointerleave", () => {
        if (document.activeElement !== chip) hidePlayerPopover();
      });
      chip.addEventListener("focus", () => showPlayerPopover(chip, profileKey));
      chip.addEventListener("blur", hidePlayerPopover);
      chip.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          hidePlayerPopover();
          chip.blur();
        }
      });
      references.players.append(chip);
    }
  } else {
    references.players.append(
      element(
        "span",
        "players-empty",
        server.playersOnline > 0 ? `${server.playersOnline} online · names unavailable` : "Nobody is online",
      ),
    );
  }
}

function activitySignature(activity) {
  return activity
    .map((event) => `${event.timestamp}\u001f${event.type}\u001f${event.player}\u001f${event.message}`)
    .join("\u001e");
}

function updateActivity(references, activity) {
  const signature = activitySignature(activity);
  if (references.activity.dataset.signature === signature) {
    updateTimeElements(references.activity);
    return;
  }
  const wasEmpty = !references.activity.dataset.signature;
  const distanceFromBottom = references.activity.scrollHeight - references.activity.scrollTop - references.activity.clientHeight;
  const followLatest = wasEmpty || distanceFromBottom < 36;
  references.activity.dataset.signature = signature;
  references.activity.replaceChildren();
  references.activityCount.textContent = activity.length ? `${activity.length} events` : "No events";
  if (!activity.length) {
    references.activity.append(element("li", "empty-line", "No recent player activity."));
    return;
  }

  activity.forEach((event) => {
    const item = element("li", `activity-item activity-item--${event.type}`);
    const time = element("time", "activity-time", relativeTime(event.timestamp));
    time.dateTime = event.timestamp;
    time.dataset.timestamp = event.timestamp;
    item.append(
      element("span", "activity-player", event.player),
      element("span", "activity-message", event.message),
      time,
    );
    references.activity.append(item);
  });
  if (followLatest) references.activity.scrollTop = references.activity.scrollHeight;
  else references.activity.scrollTop = Math.max(0, references.activity.scrollHeight - references.activity.clientHeight - distanceFromBottom);
}

function updateTimeElements(root = document) {
  for (const time of root.querySelectorAll("time[data-timestamp]")) {
    time.textContent = relativeTime(time.dataset.timestamp);
  }
}

function updateTrends(references, server, points) {
  references.historyCount.textContent = points.length ? `${points.length} sample${points.length === 1 ? "" : "s"} · 5m` : "Collecting samples";
  references.trends.players.value.textContent = `${server.playersOnline}/${server.playersMax ?? "—"}`;
  references.trends.memory.value.textContent = formatBytes(server.memoryBytes);
  references.trends.cpu.value.textContent = formatCpu(server.cpuPercent ?? points.at(-1)?.cpuPercent);
  for (const trend of Object.values(references.trends)) drawTrend(trend.chart, points, trend.metric, trend.color);
}

function updateServerPanel(panel, server) {
  const references = panelReferences.get(panel);
  references.statusDot.className = `status-dot status-dot--${server.state}`;
  references.statusText.textContent = server.state;
  references.address.textContent = server.address;
  references.motd.textContent = server.motd || "";
  references.metadata.version.textContent = server.version || "Unknown";
  references.metadata.uptime.textContent = server.state === "offline" ? "Offline" : formatDuration(server.startedAt);
  updatePlayers(references, server);
  updateActivity(references, server.activity || []);
  updateTrends(references, server, historyData.servers?.[server.id] || []);
}

function renderServers() {
  if (!dashboardData?.servers.length) {
    serverList.replaceChildren(element("div", "empty-line", "No Minecraft servers discovered."));
    serverPanels.clear();
    return;
  }

  if (serverPanels.size === 0) serverList.replaceChildren();
  const currentIds = new Set(dashboardData.servers.map((server) => server.id));
  for (const [serverId, panel] of serverPanels) {
    if (!currentIds.has(serverId)) {
      panel.remove();
      serverPanels.delete(serverId);
    }
  }

  dashboardData.servers.forEach((server, index) => {
    let panel = serverPanels.get(server.id);
    if (!panel) {
      panel = createServerPanel(server, index);
      serverPanels.set(server.id, panel);
      serverList.append(panel);
    }
    updateServerPanel(panel, server);
  });
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  refreshButton.disabled = true;
  errorMessage.hidden = true;
  try {
    const [response, historyResponse] = await Promise.all([
      fetch(new URL("servers", apiBase), { headers: { Accept: "application/json" }, cache: "no-store" }),
      fetch(new URL("history", apiBase), { headers: { Accept: "application/json" }, cache: "no-store" }),
    ]);
    if (!response.ok) throw new Error(`Status request failed (${response.status})`);
    dashboardData = await response.json();
    if (historyResponse.ok) historyData = await historyResponse.json();
    updatedAt.textContent = `Updated ${relativeTime(dashboardData.generatedAt)}`;
    renderServers();
  } catch (error) {
    errorMessage.textContent = error instanceof Error ? error.message : "Unable to load status.";
    errorMessage.hidden = false;
    updatedAt.textContent = "Update failed";
  } finally {
    refreshing = false;
    refreshButton.disabled = false;
  }
}

refreshButton.addEventListener("click", refresh);
refresh();
setInterval(refresh, 10_000);
setInterval(() => {
  if (dashboardData) {
    updatedAt.textContent = `Updated ${relativeTime(dashboardData.generatedAt)}`;
    updateTimeElements();
    updatePlayerPopoverTime();
  }
}, 5_000);
