import assert from "node:assert/strict";
import test from "node:test";
import { DiscordRestClient, expandDiscordEmojiAliases, expandDiscordUserMentions } from "../bridge/discord.mjs";

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

test("reads new messages oldest-first and authenticates requests", async () => {
  const calls = [];
  const client = new DiscordRestClient({
    token: "secret",
    channelId: "123",
    apiBase: "https://discord.test",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse([
        { id: "12", content: "second" },
        { id: "11", content: "first" },
      ]);
    },
  });
  assert.deepEqual((await client.messagesAfter("10")).map((message) => message.id), ["11", "12"]);
  assert.equal(calls[0].options.headers.Authorization, "Bot secret");
  assert.match(calls[0].url, /after=10/);
});

test("allows selected user mentions while disabling everyone and roles", async () => {
  let request;
  const client = new DiscordRestClient({
    token: "secret",
    channelId: "123",
    apiBase: "https://discord.test",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return jsonResponse({ id: "20" });
    },
  });
  await client.send("hello <@123> @everyone <@&456>", { userIds: ["123", "123"] });
  assert.equal(request.options.method, "POST");
  assert.deepEqual(JSON.parse(request.options.body), {
    content: "hello <@123> @everyone <@&456>",
    allowed_mentions: { parse: [], users: ["123"] },
  });
});

test("loads and expands available guild emoji aliases", async () => {
  const client = new DiscordRestClient({
    token: "secret",
    channelId: "123",
    apiBase: "https://discord.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/channels/123")) return jsonResponse({ guild_id: "456" });
      if (url.endsWith("/guilds/456/emojis")) {
        return jsonResponse([
          { id: "10", name: "true", animated: false, available: true },
          { id: "11", name: "dance", animated: true, available: true },
          { id: "12", name: "gone", animated: false, available: false },
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const aliases = await client.customEmojiAliases();
  assert.equal(aliases.get("true"), "<:true:10>");
  assert.equal(aliases.get("dance"), "<a:dance:11>");
  assert.equal(aliases.has("gone"), false);
  assert.equal(expandDiscordEmojiAliases("yes :true: :missing:", aliases), "yes <:true:10> :missing:");
  assert.equal(expandDiscordEmojiAliases("raw <:true:10>", aliases), "raw <:true:10>");
});

test("resolves member display names and highest colored roles", async () => {
  const client = new DiscordRestClient({
    token: "secret",
    channelId: "123",
    apiBase: "https://discord.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/channels/123")) return jsonResponse({ guild_id: "456" });
      if (url.endsWith("/guilds/456/roles")) {
        return jsonResponse([
          { id: "1", name: "Lower", color: 0xff5555, position: 2 },
          {
            id: "2",
            name: "Higher",
            color: 0xf1c40f,
            colors: { primary_color: 0xf1c40f, secondary_color: 0x9b59b6, tertiary_color: null },
            position: 4,
          },
        ]);
      }
      if (url.endsWith("/guilds/456/channels")) return jsonResponse([{ id: "123", name: "server-chat" }]);
      if (url.endsWith("/guilds/456/members/789")) return jsonResponse({ nick: "Display", roles: ["1", "2"] });
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const presentation = await client.messagePresentation({ author: { id: "789", username: "User" } });
  assert.equal(presentation.displayName, "Display");
  assert.equal(presentation.roleColor, 0xf1c40f);
  assert.deepEqual(presentation.roleColors, [0xf1c40f, 0x9b59b6]);
  assert.equal(presentation.roles.get("1").name, "Lower");
  assert.equal(presentation.channels.get("123"), "server-chat");
});

test("resolves unique usernames and display names without expanding mass mentions", () => {
  const aliases = new Map([
    ["dayl_ily", "10"],
    ["daylily", "10"],
    ['john "nomichael" mod', "20"],
  ]);
  assert.deepEqual(
    expandDiscordUserMentions('**Player**: @daylily hi @John "Nomichael" Mod @everyone @here email@example.com', aliases),
    {
      content: '**Player**: <@10> hi <@20> @everyone @here email@example.com',
      userIds: ["10", "20"],
    },
  );
});

test("loads unique member aliases and drops ambiguous display names", async () => {
  const client = new DiscordRestClient({
    token: "secret",
    channelId: "123",
    apiBase: "https://discord.test",
    fetchImpl: async (url) => {
      if (url.endsWith("/channels/123")) return jsonResponse({ guild_id: "456" });
      if (url.endsWith("/guilds/456/roles")) return jsonResponse([]);
      if (url.endsWith("/guilds/456/channels")) return jsonResponse([]);
      if (url.includes("/guilds/456/members?")) {
        return jsonResponse([
          { user: { id: "10", username: "dayl_ily", global_name: "Daylily" }, nick: null, roles: [] },
          { user: { id: "20", username: "other_user", global_name: "Same" }, nick: null, roles: [] },
          { user: { id: "30", username: "third_user", global_name: "Same" }, nick: null, roles: [] },
        ]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });
  const aliases = await client.memberMentionAliases();
  assert.equal(aliases.get("dayl_ily"), "10");
  assert.equal(aliases.get("daylily"), "10");
  assert.equal(aliases.has("same"), false);
});

test("retries Discord rate limits without exposing the token", async () => {
  let attempts = 0;
  const waits = [];
  const client = new DiscordRestClient({
    token: "secret",
    channelId: "123",
    apiBase: "https://discord.test",
    waitImpl: async (milliseconds) => waits.push(milliseconds),
    fetchImpl: async () => {
      attempts += 1;
      return attempts === 1 ? jsonResponse({ retry_after: 0.01 }, 429) : jsonResponse([]);
    },
  });
  assert.equal(await client.latestMessageId(), "0");
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [100]);
});
