import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const completionScript = path.resolve("completions/mcctl.bash");

function complete(words, environment = {}) {
  const script = `
source "$1"
shift
COMP_WORDS=("$@")
COMP_CWORD=$((\${#COMP_WORDS[@]} - 1))
_mcctl
printf '%s\n' "\${COMPREPLY[@]}"
`;
  const output = execFileSync("bash", ["--noprofile", "--norc", "-c", script, "bash", completionScript, ...words], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  return output.split("\n").filter(Boolean);
}

test("completes commands, options, specs, and memory values", () => {
  assert.deepEqual(complete(["mcctl", "cr"]), ["create"]);
  assert.deepEqual(complete(["mcctl", "create", "demo", "latest-f"]), ["latest-fabric", "latest-forge"]);
  assert.deepEqual(complete(["mcctl", "create", "demo", "1.12.2-f"]), ["1.12.2-fabric", "1.12.2-forge"]);
  assert.deepEqual(complete(["mcctl", "create", "demo", "--mem"]), ["--memory"]);
  assert.deepEqual(complete(["mcctl", "create", "demo", "--memory", ""]), ["1G", "2G", "4G", "6G", "8G", "12G", "16G"]);
  assert.deepEqual(complete(["mcctl", "create", "demo", "--spec=latest-v"]), ["--spec=latest-vanilla"]);
});

test("completes existing instances and launch files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-completion-"));
  try {
    await mkdir(path.join(root, "alpha"));
    await mkdir(path.join(root, "bravo"));
    await writeFile(path.join(root, "alpha", "start.sh"), "#!/bin/sh\n");
    assert.deepEqual(complete(["mcctl", "status", "a"], { MCCTL_ROOT: root }), ["alpha"]);
    assert.deepEqual(
      complete(["mcctl", "adopt", "alpha", "--launch", "./s"], { MCCTL_ROOT: root }),
      ["./start.sh"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});