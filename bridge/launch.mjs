#!/usr/bin/env node
import { promises as fs } from "node:fs";
import process from "node:process";
import { bridgePaths, readBridgeStatus } from "../lib/bridge-config.mjs";
import { validateInstanceName } from "../lib/instances.mjs";
import { syncRendererPlugin } from "./renderer-plugin.mjs";

const instance = validateInstanceName(process.argv[2]);
const bridgeRoot = process.env.MCCTL_BRIDGE_ROOT || "/etc/mcctl/bridges";
const instanceRoot = process.env.MCCTL_ROOT || "/srv/minecraft";
const status = await readBridgeStatus(instance, bridgeRoot);
if (!status.enabled || !status.config) throw new Error(`Bridge is not enabled for ${instance}`);
const instanceDirectory = `${instanceRoot}/${instance}`;
if (status.config.commandStyle === "broadcast") await syncRendererPlugin(instanceDirectory);
const token = (await fs.readFile(bridgePaths(instance, bridgeRoot).token, "utf8")).trim();
if (!token) throw new Error(`Bridge token is missing for ${instance}`);

process.env.DISCORD_BOT_TOKEN = token;
process.env.DISCORD_CHANNEL_ID = status.config.channelId;
process.env.MINECRAFT_CWD = instanceDirectory;
process.env.MINECRAFT_START_SCRIPT = "./run";
process.env.MINECRAFT_COMMAND_STYLE = status.config.commandStyle;
process.env.ANNOUNCE_LIFECYCLE = String(status.config.announceLifecycle);
await import("./main.mjs");
