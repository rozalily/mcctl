import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const bootstrap = path.resolve("bootstrap.sh");

async function executable(filename, content) {
  await writeFile(filename, content);
  await chmod(filename, 0o755);
  return filename;
}

test("downloads, validates, installs, and cleans a GitHub source archive", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcctl-bootstrap-test-"));
  const archiveRoot = path.join(directory, "archive");
  const source = path.join(archiveRoot, "mcctl-fixture");
  const archive = path.join(directory, "mcctl.tar.gz");
  const fakeBin = path.join(directory, "bin");
  const marker = path.join(directory, "installer");
  try {
    await mkdir(path.join(source, "lib"), { recursive: true });
    await mkdir(fakeBin);
    await writeFile(
      path.join(source, "install.sh"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$@" > "$BOOTSTRAP_MARKER.args"\nprintf "%s\\n" "${BASH_SOURCE[0]}" > "$BOOTSTRAP_MARKER.source"\n',
    );
    await writeFile(path.join(source, "mcctl.mjs"), "");
    await writeFile(path.join(source, "lib", "instances.mjs"), "");
    await writeFile(path.join(source, "lib", "specs.mjs"), "");
    const packed = spawnSync("tar", ["-czf", archive, "-C", archiveRoot, "mcctl-fixture"], { encoding: "utf8" });
    assert.equal(packed.status, 0, packed.stderr);
    await executable(
      path.join(fakeBin, "curl"),
      '#!/bin/sh\nset -eu\nprintf "%s\\n" "$@" > "$BOOTSTRAP_CURL_ARGS"\noutput=\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in\n    --output) shift; output=$1;;\n  esac\n  shift\ndone\ntest -n "$output"\n/bin/cp "$BOOTSTRAP_TEST_ARCHIVE" "$output"\n',
    );

    const result = spawnSync("bash", [bootstrap, "--with-dashboard"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH}`,
        MCCTL_ARCHIVE_URL: "https://example.test/mcctl.tar.gz",
        BOOTSTRAP_TEST_ARCHIVE: archive,
        BOOTSTRAP_CURL_ARGS: `${marker}.curl-args`,
        BOOTSTRAP_MARKER: marker,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Downloading mcctl/);
    assert.match(result.stdout, /Running mcctl installer/);
    assert.equal(await readFile(`${marker}.args`, "utf8"), "--with-dashboard\n");
    const curlArgs = await readFile(`${marker}.curl-args`, "utf8");
    assert.match(curlArgs, /--fail/);
    assert.match(curlArgs, /https:\/\/example\.test\/mcctl\.tar\.gz/);
    const extractedInstaller = (await readFile(`${marker}.source`, "utf8")).trim();
    await assert.rejects(stat(extractedInstaller));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
