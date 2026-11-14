import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const installer = path.resolve("install.sh");

async function executable(filename, content) {
  await writeFile(filename, content);
  await chmod(filename, 0o755);
  return filename;
}

function ensureAccount(environment) {
  return spawnSync("bash", ["--noprofile", "--norc", "-c", 'source "$1"; ensure_minecraft_account', "bash", installer], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
}

test("warns and preserves an existing minecraft account", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcctl-account-existing-"));
  const marker = path.join(directory, "useradd-called");
  try {
    const id = await executable(path.join(directory, "id"), "#!/bin/sh\nexit 0\n");
    const getent = await executable(
      path.join(directory, "getent"),
      '#!/bin/sh\ncase "$1" in passwd) echo "minecraft:x:123:456::/srv/minecraft:/usr/sbin/nologin";; group) echo "minecraft:x:456:";; esac\n',
    );
    const useradd = await executable(path.join(directory, "useradd"), `#!/bin/sh\ntouch ${marker}\n`);
    const result = ensureAccount({ MCCTL_ID_BIN: id, MCCTL_GETENT_BIN: getent, MCCTL_USERADD_BIN: useradd });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /Warning: account 'minecraft' already exists/);
    assert.match(result.stderr, /uid=123 gid=456/);
    await assert.rejects(stat(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("creates a locked system account and group when absent", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcctl-account-create-"));
  const marker = path.join(directory, "useradd-args");
  try {
    const id = await executable(path.join(directory, "id"), "#!/bin/sh\nexit 1\n");
    const getent = await executable(
      path.join(directory, "getent"),
      `#!/bin/sh\nif [ "$1" = group ] && [ -f ${marker} ]; then echo "minecraft:x:456:"; exit 0; fi\nexit 2\n`,
    );
    const useradd = await executable(path.join(directory, "useradd"), `#!/bin/sh\nprintf '%s\\n' "$*" > ${marker}\n`);
    const nologin = await executable(path.join(directory, "nologin"), "#!/bin/sh\nexit 1\n");
    const result = ensureAccount({
      MCCTL_ID_BIN: id,
      MCCTL_GETENT_BIN: getent,
      MCCTL_USERADD_BIN: useradd,
      MCCTL_NOLOGIN_BIN: nologin,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Created system account 'minecraft'/);
    const args = await readFile(marker, "utf8");
    assert.match(args, /--system --user-group --home-dir \/srv\/minecraft --create-home --shell/);
    assert.match(args, /minecraft\s*$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("stages the complete optional dashboard without system changes", async () => {
  const destination = await mkdtemp(path.join(os.tmpdir(), "mcctl-dashboard-install-"));
  try {
    const result = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", 'source "$1"; install_dashboard "$(dirname "$1")"', "bash", installer],
      { encoding: "utf8", env: { ...process.env, MCCTL_DESTDIR: destination } },
    );
    assert.equal(result.status, 0, result.stderr);
    for (const filename of [
      "usr/local/libexec/mcctl-dashboard/server.mjs",
      "usr/local/libexec/mcctl-dashboard/lib/dashboard.mjs",
      "usr/local/libexec/mcctl-dashboard/public/index.html",
      "usr/local/libexec/mcctl-dashboard/public/vendor/skinview3d/skinview3d.bundle.js",
      "etc/systemd/system/mcctl-dashboard.service",
      "etc/default/mcctl-dashboard",
    ]) {
      assert.equal((await stat(path.join(destination, filename))).isFile(), true, filename);
    }
    assert.equal((await stat(path.join(destination, "usr/local/libexec/mcctl-dashboard/run"))).mode & 0o777, 0o755);
    assert.equal((await stat(path.join(destination, "var/lib/mcctl-dashboard"))).mode & 0o777, 0o750);
  } finally {
    await rm(destination, { recursive: true, force: true });
  }
});