const API_BASE = "https://discord.com/api/v10";
const MAX_ATTEMPTS = 4;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function compareSnowflakes(left, right) {
  const a = BigInt(left.id);
  const b = BigInt(right.id);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function expandDiscordEmojiAliases(content, aliases) {
  return String(content).replace(/(^|[^<\w]):([A-Za-z0-9_]{2,32}):(?=$|[^\w])/g, (match, prefix, name) => {
    const emoji = aliases.get(name);
    return emoji ? `${prefix}${emoji}` : match;
  });
}

export function expandDiscordUserMentions(content, aliases) {
  let expanded = String(content);
  const userIds = new Set();
  const entries = [...aliases.entries()].sort(([left], [right]) => right.length - left.length);
  for (const [alias, userId] of entries) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(`(^|\\s)@${escaped}(?=$|[\\s.,!?;:()\\[\\]{}])`, "giu");
    expanded = expanded.replace(pattern, (match, prefix) => {
      userIds.add(userId);
      return `${prefix}<@${userId}>`;
    });
  }
  return { content: expanded, userIds: [...userIds].sort() };
}

export class DiscordRestClient {
  constructor({ token, channelId, fetchImpl = fetch, waitImpl = wait, apiBase = API_BASE }) {
    if (!token) throw new Error("DISCORD_BOT_TOKEN is required");
    if (!/^\d+$/.test(channelId || "")) throw new Error("DISCORD_CHANNEL_ID must be numeric");
    this.token = token;
    this.channelId = channelId;
    this.fetchImpl = fetchImpl;
    this.waitImpl = waitImpl;
    this.apiBase = apiBase;
    this.guildContextPromise = null;
    this.memberAliasesPromise = null;
    this.memberCache = new Map();
  }

  async request(route, options = {}) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const response = await this.fetchImpl(`${this.apiBase}${route}`, {
        ...options,
        headers: {
          Authorization: `Bot ${this.token}`,
          "Content-Type": "application/json",
          "User-Agent": "minecraft-discord-bridge/0.1",
          ...options.headers,
        },
        signal: AbortSignal.timeout(10_000),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : null;
      if (response.status === 429 && attempt < MAX_ATTEMPTS) {
        await this.waitImpl(Math.max(100, Math.ceil(Number(data?.retry_after || 1) * 1_000)));
        continue;
      }
      if (!response.ok) throw new Error(`Discord API ${response.status}: ${data?.message || response.statusText}`);
      return data;
    }
    throw new Error("Discord API retry limit exceeded");
  }

  async latestMessageId() {
    const messages = await this.request(`/channels/${this.channelId}/messages?limit=1`);
    return messages[0]?.id ?? "0";
  }

  async customEmojiAliases() {
    const channel = await this.request(`/channels/${this.channelId}`);
    if (!channel.guild_id) return new Map();
    const emojis = await this.request(`/guilds/${channel.guild_id}/emojis`);
    return new Map(
      emojis
        .filter((emoji) => emoji.available !== false && /^[A-Za-z0-9_]{2,32}$/.test(emoji.name || ""))
        .map((emoji) => [emoji.name, `<${emoji.animated ? "a" : ""}:${emoji.name}:${emoji.id}>`]),
    );
  }

  async guildContext() {
    if (!this.guildContextPromise) {
      this.guildContextPromise = (async () => {
        const channel = await this.request(`/channels/${this.channelId}`);
        if (!channel.guild_id) return null;
        const [roles, channels] = await Promise.all([
          this.request(`/guilds/${channel.guild_id}/roles`),
          this.request(`/guilds/${channel.guild_id}/channels`),
        ]);
        return {
          guildId: channel.guild_id,
          roles: new Map(roles.map((role) => [role.id, role])),
          channels: new Map(channels.map((entry) => [entry.id, entry.name])),
        };
      })();
    }
    return this.guildContextPromise;
  }

  async messagePresentation(message) {
    const context = await this.guildContext();
    if (!context || !message.author?.id) return null;
    let member = this.memberCache.get(message.author.id);
    if (!member) {
      member = await this.request(`/guilds/${context.guildId}/members/${message.author.id}`);
      this.memberCache.set(message.author.id, member);
    }
    const coloredRole = member.roles
      .map((roleId) => context.roles.get(roleId))
      .filter((role) => (role?.colors?.primary_color ?? role?.color ?? 0) !== 0)
      .sort((left, right) => right.position - left.position)[0];
    return {
      displayName: member.nick || message.author.global_name || message.author.username,
      roleColor: coloredRole?.colors?.primary_color ?? coloredRole?.color ?? 0,
      roles: context.roles,
      channels: context.channels,
    };
  }

  async memberMentionAliases() {
    if (!this.memberAliasesPromise) {
      this.memberAliasesPromise = (async () => {
        const context = await this.guildContext();
        if (!context) return new Map();
        const candidates = new Map();
        let after = "0";
        while (true) {
          const members = await this.request(`/guilds/${context.guildId}/members?limit=1000&after=${after}`);
          for (const member of members) {
            this.memberCache.set(member.user.id, member);
            const names = [member.user.username, member.user.global_name, member.nick]
              .filter(Boolean)
              .map((name) => String(name).replace(/\s+/g, " ").trim().toLowerCase())
              .filter((name) => name && name !== "everyone" && name !== "here");
            for (const name of names) {
              const ids = candidates.get(name) || new Set();
              ids.add(member.user.id);
              candidates.set(name, ids);
            }
          }
          if (members.length < 1000) break;
          after = members.at(-1).user.id;
        }
        return new Map(
          [...candidates.entries()].filter(([, ids]) => ids.size === 1).map(([name, ids]) => [name, ids.values().next().value]),
        );
      })();
    }
    return this.memberAliasesPromise;
  }

  async messagesAfter(after) {
    if (!after) return [];
    const collected = [];
    let cursor = after;
    while (true) {
      const messages = await this.request(`/channels/${this.channelId}/messages?after=${cursor}&limit=100`);
      if (!Array.isArray(messages) || messages.length === 0) break;
      messages.sort(compareSnowflakes);
      collected.push(...messages);
      cursor = messages.at(-1).id;
      if (messages.length < 100) break;
    }
    return collected;
  }

  async send(content, { userIds = [] } = {}) {
    const body = String(content).slice(0, 2_000);
    const users = [...new Set(userIds)].slice(0, 100);
    return this.request(`/channels/${this.channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({ content: body, allowed_mentions: { parse: [], users } }),
    });
  }
}
