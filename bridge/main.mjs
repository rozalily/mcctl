#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { DiscordRestClient, expandDiscordEmojiAliases, expandDiscordUserMentions } from "./discord.mjs";
import { discordMessageToCommand, watchMinecraftOutput } from "./minecraft.mjs";

function positiveInteger(value, fallback, name) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function enabled(value, fallback = true) {
  if (value === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(value.toLowerCase());
}

const minecraftDirectory = path.resolve(process.env.MINECRAFT_CWD || process.cwd());
const startScript = process.env.MINECRAFT_START_SCRIPT || "./start.sh";
const pollIntervalMs = positiveInteger(process.env.POLL_INTERVAL_MS, 2_500, "POLL_INTERVAL_MS");
const shutdownTimeoutMs = positiveInteger(process.env.SHUTDOWN_TIMEOUT_MS, 120_000, "SHUTDOWN_TIMEOUT_MS");
const announceLifecycle = enabled(process.env.ANNOUNCE_LIFECYCLE);
const commandStyle = process.env.MINECRAFT_COMMAND_STYLE || "tellraw";
if (!["tellraw", "say", "broadcast"].includes(commandStyle)) {
  throw new Error("MINECRAFT_COMMAND_STYLE must be tellraw, say, or broadcast");
}

await fs.access(path.resolve(minecraftDirectory, startScript));
let discord = null;
let cursor = "0";
let emojiAliases = new Map();
let userMentionAliases = new Map();
if (process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_CHANNEL_ID) {
  try {
    discord = new DiscordRestClient({
      token: process.env.DISCORD_BOT_TOKEN,
      channelId: process.env.DISCORD_CHANNEL_ID,
    });
    cursor = await discord.latestMessageId();
    try {
      emojiAliases = await discord.customEmojiAliases();
    } catch (error) {
      console.error(`Discord emoji aliases unavailable: ${error.message}`);
    }
    try {
      userMentionAliases = await discord.memberMentionAliases();
    } catch (error) {
      console.error(`Discord user mentions unavailable: ${error.message}`);
    }
  } catch (error) {
    console.error(`Discord relay disabled: ${error.message}`);
    discord = null;
  }
} else {
  console.error("Discord relay disabled: set DISCORD_BOT_TOKEN and DISCORD_CHANNEL_ID in .env.");
}
let stopping = false;
let forceTimer;
let outbound = Promise.resolve();
const queueDiscord = (content, userIds = []) => {
  if (!discord) return;
  outbound = outbound.then(() => discord.send(content, { userIds })).catch((error) => {
    console.error(`Discord send failed: ${error.message}`);
  });
};

const server = spawn("/bin/sh", [startScript], {
  cwd: minecraftDirectory,
  stdio: ["pipe", "pipe", "pipe"],
});
server.once("error", (error) => {
  console.error(`Unable to start Minecraft: ${error.message}`);
});
process.stdin.pipe(server.stdin, { end: false });

const serverLines = watchMinecraftOutput(server, {
  onEvent(event) {
    const withEmoji = expandDiscordEmojiAliases(event.content, emojiAliases);
    const withMentions = expandDiscordUserMentions(withEmoji, userMentionAliases);
    queueDiscord(withMentions.content, withMentions.userIds);
  },
});

async function pollDiscord() {
  if (!discord) return;
  while (!stopping) {
    try {
      const messages = await discord.messagesAfter(cursor);
      for (const message of messages) {
        cursor = message.id;
        let presentation = null;
        if (!message.webhook_id && !message.author?.bot) {
          try {
            presentation = await discord.messagePresentation(message);
          } catch (error) {
            console.error(`Discord member formatting unavailable: ${error.message}`);
          }
        }
        const command = discordMessageToCommand(message, { style: commandStyle, presentation });
        if (command && !server.stdin.destroyed) server.stdin.write(`${command}\n`);
      }
    } catch (error) {
      console.error(`Discord poll failed: ${error.message}`);
    }
    if (!stopping) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function requestShutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.error(`Received ${signal}; requesting a clean Minecraft shutdown.`);
  if (!server.stdin.destroyed) server.stdin.write("stop\n");
  forceTimer = setTimeout(() => {
    console.error("Minecraft did not stop before the timeout; sending SIGTERM.");
    server.kill("SIGTERM");
  }, shutdownTimeoutMs);
  forceTimer.unref();
}

process.once("SIGINT", () => requestShutdown("SIGINT"));
process.once("SIGTERM", () => requestShutdown("SIGTERM"));
if (announceLifecycle) queueDiscord("✅ Server started");
const poller = pollDiscord();
const exit = await new Promise((resolve) => server.once("exit", (code, signal) => resolve({ code, signal })));
stopping = true;
clearTimeout(forceTimer);
for (const lines of serverLines) lines.close();
if (announceLifecycle) queueDiscord("🛑 Server stopped");
await poller;
await outbound;
process.exitCode = exit.code ?? 1;
