import assert from "node:assert/strict";
import test from "node:test";
import { parseArguments, resolveInstanceService } from "../mcctl.mjs";

test("boolean options do not consume following positional arguments", () => {
  const parsed = parseArguments(["--accept-eula", "server", "latest-fabric", "--yes"]);
  assert.deepEqual(parsed.positional, ["server", "latest-fabric"]);
  assert.equal(parsed.has("accept-eula"), true);
  assert.equal(parsed.has("yes"), true);
});

test("parses repeated and equals-form options", () => {
  const parsed = parseArguments(["server", "--launch=./start.sh", "--arg", "nogui", "--arg=--safe"]);
  assert.deepEqual(parsed.positional, ["server"]);
  assert.equal(parsed.get("launch"), "./start.sh");
  assert.deepEqual(parsed.all("arg"), ["nogui", "--safe"]);
});

test("rejects missing option values and valued boolean flags", () => {
  assert.throws(() => parseArguments(["server", "--port"]), /requires a value/);
  assert.throws(() => parseArguments(["server", "--yes=false"]), /does not accept a value/);
});

test("selects generic and standalone instance services accurately", async () => {
  const states = new Map([
    ["minecraft@modern.service", "active"],
    ["minecraft@legacy.service", "inactive"],
    ["legacy.service", "active"],
  ]);
  const runCommand = async (_command, args) => {
    const state = states.get(args.at(-1)) || "inactive";
    if (state !== "active") throw Object.assign(new Error(state), { stdout: `${state}\n` });
    return { stdout: `${state}\n` };
  };

  assert.deepEqual(await resolveInstanceService("modern", false, runCommand), {
    unit: "minecraft@modern.service",
    state: "active",
  });
  assert.deepEqual(await resolveInstanceService("legacy", false, runCommand), {
    unit: "legacy.service",
    state: "active",
  });
});
