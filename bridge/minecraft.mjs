import { createInterface } from "node:readline";

const MAX_DISCORD_MESSAGE_LENGTH = 1_900;
const MAX_MINECRAFT_MESSAGE_LENGTH = 450;
const MAX_BETA_MESSAGE_LENGTH = 100;
const MINECRAFT_COLORS = [
  ["0", 0x000000],
  ["1", 0x0000aa],
  ["2", 0x00aa00],
  ["3", 0x00aaaa],
  ["4", 0xaa0000],
  ["5", 0xaa00aa],
  ["6", 0xffaa00],
  ["7", 0xaaaaaa],
  ["8", 0x555555],
  ["9", 0x5555ff],
  ["a", 0x55ff55],
  ["b", 0x55ffff],
  ["c", 0xff5555],
  ["d", 0xff55ff],
  ["e", 0xffff55],
  ["f", 0xffffff],
];

export function stripMinecraftFormatting(value) {
  return value
    .replace(/\u001b(?:\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    .replace(/§x(?:§[0-9a-f]){6}/gi, "")
    .replace(/§[0-9a-fk-or]/gi, "")
    .replaceAll("\u0000", "");
}

function logPayload(line) {
  const cleaned = stripMinecraftFormatting(line).trim();
  const modern = /^\[[^\]]+\] \[[^\]]+\/INFO\](?: \[[^\]]+\])?: (.+)$/.exec(cleaned);
  if (modern) return modern[1];
  const legacy = /^(?:\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}:\d{2} \[(?:INFO|WARNING|SEVERE)\](?: \[[^\]]+\])?:? (.+)$/.exec(cleaned);
  return legacy?.[1] ?? null;
}

function cleanDiscordText(value) {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_DISCORD_MESSAGE_LENGTH);
}

export function parseMinecraftEvent(line) {
  const payload = logPayload(line);
  if (!payload) return null;

  const chat = /^(?:\[Not Secure\] )?<([^>]{1,32})> (.+)$/.exec(payload);
  if (chat) return { type: "chat", content: `**${cleanDiscordText(chat[1])}**: ${cleanDiscordText(chat[2])}` };

  const presence = /^([^\s]{1,32}) (?:(joined|left) the game|has (left) the game\.?)$/.exec(payload);
  if (presence) {
    const action = presence[2] || presence[3];
    return { type: action, content: `*${cleanDiscordText(presence[1])} ${action} the game.*` };
  }

  const legacyLogin = /^([A-Za-z0-9_]{1,32}) \[\/[^\]]+\] logged in with entity id /.exec(payload);
  if (legacyLogin) return { type: "joined", content: `*${legacyLogin[1]} joined the game.*` };
  const legacyDisconnect = /^([A-Za-z0-9_]{1,32}) lost connection(?::.*)?$/.exec(payload);
  if (legacyDisconnect) return { type: "left", content: `*${legacyDisconnect[1]} left the game.*` };

  const advancement = /^([^\s]{1,32}) has (made the advancement|completed the challenge|reached the goal) \[(.+)\]$/.exec(payload);
  if (advancement) {
    return {
      type: "advancement",
      content: `*${cleanDiscordText(advancement[1])} ${advancement[2]} ${cleanDiscordText(advancement[3])}.*`,
    };
  }

  const death = /^([A-Za-z0-9_]{1,32}) (was|fell|drowned|burned|blew|hit|walked|went|starved|suffocated|froze|impaled|poked|roasted|pricked|squashed|killed|didn't|discovered|experienced|tried|withered|shot|slain|left)\b.+/.exec(payload);
  if (death) return { type: "death", content: `*${cleanDiscordText(payload)}*` };

  return null;
}

export function watchMinecraftOutput(server, { stdout = process.stdout, stderr = process.stderr, onEvent } = {}) {
  return [
    [server.stdout, stdout],
    [server.stderr, stderr],
  ].map(([input, output]) => {
    const lines = createInterface({ input, terminal: false });
    lines.on("line", (line) => {
      output.write(`${line}\n`);
      const event = parseMinecraftEvent(line);
      if (event) onEvent(event);
    });
    return lines;
  });
}

function discordAuthorName(message) {
  return cleanDiscordText(message.member?.nick || message.author?.global_name || message.author?.username || "Discord").slice(0, 32);
}

function nearestMinecraftColor(rgb) {
  if (!rgb) return "f";
  const red = (rgb >> 16) & 0xff;
  const green = (rgb >> 8) & 0xff;
  const blue = rgb & 0xff;
  return MINECRAFT_COLORS.reduce(
    (best, [code, color]) => {
      const distance = (red - ((color >> 16) & 0xff)) ** 2 + (green - ((color >> 8) & 0xff)) ** 2 + (blue - (color & 0xff)) ** 2;
      return distance < best.distance ? { code, distance } : best;
    },
    { code: "f", distance: Number.POSITIVE_INFINITY },
  ).code;
}

function discordDisplayContent(message, presentation, legacyColors = false) {
  const color = (value, code) => (legacyColors ? `§${code}${value}§f` : value);
  let content = stripMinecraftFormatting(cleanDiscordText(String(message.content || ""))).replace(
    /<a?:([A-Za-z0-9_]{2,32}):\d+>/g,
    ":$1:",
  );
  for (const mention of message.mentions || []) {
    const name = mention.member?.nick || mention.global_name || mention.username || mention.id;
    const display = color(`@${stripMinecraftFormatting(cleanDiscordText(name))}`, "9");
    content = content.replaceAll(`<@${mention.id}>`, display).replaceAll(`<@!${mention.id}>`, display);
  }
  for (const roleId of message.mention_roles || []) {
    const role = presentation?.roles?.get(roleId);
    if (!role) continue;
    const roleColor = role.colors?.primary_color ?? role.color ?? 0;
    content = content.replaceAll(`<@&${roleId}>`, color(`@${stripMinecraftFormatting(cleanDiscordText(role.name))}`, nearestMinecraftColor(roleColor)));
  }
  content = content.replace(/<#(\d+)>/g, (match, channelId) => {
    const name = presentation?.channels?.get(channelId);
    return name ? color(`#${stripMinecraftFormatting(cleanDiscordText(name))}`, "9") : match;
  });
  content = content.replace(/@(everyone|here)\b/g, (match) => color(match, "9"));
  return content;
}

export function discordMessageToCommand(message, { style = "tellraw", presentation = null } = {}) {
  if (!message || message.webhook_id || message.author?.bot) return null;
  const attachments = Array.isArray(message.attachments)
    ? message.attachments
        .map((attachment) => {
          if (style !== "broadcast" && style !== "say") return attachment.url;
          const filename = stripMinecraftFormatting(cleanDiscordText(attachment.filename || "attachment"));
          return style === "broadcast" ? `§9[${filename}]§f` : `[${filename}]`;
        })
        .filter(Boolean)
    : [];
  const body = [discordDisplayContent(message, presentation, style === "broadcast"), ...attachments]
    .filter(Boolean)
    .join(" ")
    .slice(0, MAX_MINECRAFT_MESSAGE_LENGTH);
  if (!body) return null;
  const name = stripMinecraftFormatting(cleanDiscordText(presentation?.displayName || discordAuthorName(message))).slice(0, 32);
  if (style === "broadcast") {
    const prefix = `§f<§${nearestMinecraftColor(presentation?.roleColor)}${name}§f> `;
    return `mcctlrelay ${prefix}${body}`;
  }
  if (style === "say") {
    const prefix = `[Discord] ${name}: `;
    return `say ${prefix}${body.slice(0, Math.max(0, MAX_BETA_MESSAGE_LENGTH - prefix.length))}`;
  }
  if (style !== "tellraw") throw new Error(`Unsupported MINECRAFT_COMMAND_STYLE: ${style}`);
  const component = {
    text: "",
    extra: [
      { text: "<", color: "white" },
      { text: name, color: presentation?.roleColor ? `#${presentation.roleColor.toString(16).padStart(6, "0")}` : "white" },
      { text: "> ", color: "white" },
      { text: body, color: "white" },
    ],
  };
  return `tellraw @a ${JSON.stringify(component)}`;
}
