import assert from "node:assert/strict";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { discordMessageToCommand, parseMinecraftEvent, watchMinecraftOutput } from "../bridge/minecraft.mjs";

test("parses relevant Minecraft console events", () => {
  assert.deepEqual(parseMinecraftEvent("[12:00:00] [Server thread/INFO]: <Alpha> hello"), {
    type: "chat",
    content: "**Alpha**: hello",
  });
  assert.deepEqual(parseMinecraftEvent("[27Nov2026 12:00:00.000] [Server thread/INFO] [minecraft/MinecraftServer]: Beta joined the game"), {
    type: "joined",
    content: "*Beta joined the game.*",
  });
  assert.deepEqual(parseMinecraftEvent("[12:00:00] [Server thread/INFO]: Alpha has made the advancement [Stone Age]"), {
    type: "advancement",
    content: "*Alpha made the advancement Stone Age.*",
  });
  assert.deepEqual(parseMinecraftEvent("2026-11-27 12:00:00 [INFO] <BetaPlayer> hello from beta"), {
    type: "chat",
    content: "**BetaPlayer**: hello from beta",
  });
  assert.deepEqual(parseMinecraftEvent("11:41:04 [INFO] <~lily> tst"), {
    type: "chat",
    content: "**~lily**: tst",
  });
  assert.deepEqual(
    parseMinecraftEvent("2026-11-27 12:00:01 [INFO] BetaPlayer [/127.0.0.1:1234] logged in with entity id 3 at ([world] 0, 64, 0)"),
    { type: "joined", content: "*BetaPlayer joined the game.*" },
  );
  assert.deepEqual(parseMinecraftEvent("2026-11-27 12:00:02 [INFO] BetaPlayer lost connection: disconnect.endOfStream"), {
    type: "left",
    content: "*BetaPlayer left the game.*",
  });
  assert.equal(parseMinecraftEvent("[12:00:00] [Server thread/INFO]: Saving chunks"), null);
});

test("reads Minecraft events written only to child stderr", async () => {
  const server = { stdout: new PassThrough(), stderr: new PassThrough() };
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const events = [];
  const lines = watchMinecraftOutput(server, { stdout, stderr, onEvent: (event) => events.push(event) });

  server.stderr.end("11:54:59 [INFO] <~lily> test 2\n");
  await once(lines[1], "close");
  lines[0].close();

  assert.deepEqual(events, [{ type: "chat", content: "**~lily**: test 2" }]);
  assert.equal(stderr.read().toString(), "11:54:59 [INFO] <~lily> test 2\n");
});

test("formats Discord messages as one safe tellraw command", () => {
  const command = discordMessageToCommand(
    {
      author: { username: "User", bot: false },
      member: { nick: 'Name"\\with newline\n' },
      content: 'hello"}\nstop',
      attachments: [{ url: "https://example.test/image.png" }],
    },
    { presentation: { displayName: "Display", roleColor: 0xf1c40f } },
  );
  assert.match(command, /^tellraw @a /);
  assert.equal(command.split("\n").length, 1);
  const component = JSON.parse(command.slice("tellraw @a ".length));
  assert.deepEqual(component.extra.slice(0, 3), [
    { text: "<", color: "white" },
    { text: "Display", color: "#f1c40f" },
    { text: "> ", color: "white" },
  ]);
  assert.equal(component.extra[3].text, 'hello"} stop https://example.test/image.png');
  assert.equal(discordMessageToCommand({ author: { username: "Bot", bot: true }, content: "ignored" }), null);
  assert.equal(discordMessageToCommand({ webhook_id: "1", author: { username: "Hook" }, content: "ignored" }), null);
});

test("interpolates enhanced Discord role colors across modern display names", () => {
  const command = discordMessageToCommand(
    { author: { username: "User", bot: false }, content: "gradient", attachments: [] },
    { presentation: { displayName: "ABC", roleColor: 0xff0000, roleColors: [0xff0000, 0x0000ff] } },
  );
  const component = JSON.parse(command.slice("tellraw @a ".length));
  assert.deepEqual(component.extra.slice(1, 4), [
    { text: "A", color: "#ff0000" },
    { text: "B", color: "#800080" },
    { text: "C", color: "#0000ff" },
  ]);
  assert.deepEqual(component.extra[4], { text: "> ", color: "white" });
});

test("highlights modern user, role, channel, and mass mentions", () => {
  const command = discordMessageToCommand(
    {
      author: { username: "User", bot: false },
      content: "hi <@10> <@&20> in <#30> @everyone",
      mentions: [{ id: "10", username: "dayl_ily", global_name: "daylily" }],
      mention_roles: ["20"],
      attachments: [],
    },
    {
      presentation: {
        displayName: "Roza",
        roleColor: 0xff0000,
        roles: new Map([["20", { id: "20", name: "Builders", color: 0xff8800 }]]),
        channels: new Map([["30", "screenshots"]]),
      },
    },
  );
  const component = JSON.parse(command.slice("tellraw @a ".length));
  assert.deepEqual(
    component.extra.slice(3),
    [
      { text: "hi ", color: "white" },
      { text: "@daylily", color: "blue" },
      { text: " ", color: "white" },
      { text: "@Builders", color: "#ff8800" },
      { text: " in ", color: "white" },
      { text: "#screenshots", color: "blue" },
      { text: " ", color: "white" },
      { text: "@everyone", color: "blue" },
    ],
  );
});

test("formats Beta Discord messages as bounded say commands", () => {
  const command = discordMessageToCommand(
    {
      author: { username: "User", bot: false },
      content: `hello <:true:123> <@456>\nstop ${"x".repeat(200)}`,
      mentions: [{ id: "456", username: "Mentioned", member: { nick: "Nick" } }],
      attachments: [],
    },
    { style: "say" },
  );
  assert.match(command, /^say \[Discord\] User: hello :true: @Nick stop /);
  assert.equal(command.split("\n").length, 1);
  assert.equal(command.slice("say ".length).length, 100);
  assert.throws(() => discordMessageToCommand({ author: { username: "User" }, content: "hi" }, { style: "invalid" }), /Unsupported/);
});

test("formats legacy Bukkit messages with the original colors and no server prefix", () => {
  const roles = new Map([["20", { id: "20", name: "Red Role", color: 0xff5555 }]]);
  const channels = new Map([["30", "server-chat"]]);
  const command = discordMessageToCommand(
    {
      author: { username: "User", bot: false },
      member: { nick: "Name§c" },
      content: "hello <:true:123> <@10> <@&20> <#30> §4not red",
      mentions: [{ id: "10", username: "Mentioned", member: { nick: "Nick" } }],
      mention_roles: ["20"],
      attachments: [],
    },
    { style: "broadcast", presentation: { displayName: "Daylily", roleColor: 0xf1c40f, roles, channels } },
  );
  assert.equal(command, "mcctlrelay §f<§6Daylily§f> hello :true: §9@Nick§f §c@Red Role§f §9#server-chat§f not red");
});

test("keeps long Bukkit messages for server-side wrapping and compacts attachments", () => {
  const content = `a long message with normal word boundaries ${"word ".repeat(30)}`.trim();
  const command = discordMessageToCommand(
    {
      author: { username: "User", bot: false },
      content,
      attachments: [{ filename: "image.png", url: "https://cdn.discordapp.com/attachments/very/long/image.png" }],
    },
    { style: "broadcast", presentation: { displayName: "User", roleColor: 0 } },
  );
  assert.match(command, /^mcctlrelay §f<§fUser§f> a long message/);
  assert.match(command, /§9\[image\.png\]§f$/);
  assert.doesNotMatch(command, /cdn\.discordapp\.com/);
  assert.ok(command.length > 100);
});
