import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  adoptInstance,
  buildAdoptedRunScript,
  buildRunScript,
  createEmptyInstance,
  createResolvedInstance,
  doctorInstance,
  readManifest,
  setEula,
  setServerProperty,
  validateInstanceName,
} from "../lib/instances.mjs";

const JAVA_8 = "/usr/lib/jvm/temurin-8-jre-amd64/bin/java";

function resolvedVanilla(body, sha1 = createHash("sha1").update(body).digest("hex")) {
  return {
    requestedSpec: "1.12.2-vanilla",
    distribution: "vanilla",
    minecraftVersion: "1.12.2",
    loaderVersion: null,
    installerVersion: null,
    javaMajor: 8,
    artifact: { url: "https://example.test/server.jar", sha1, filename: "server.jar" },
    installKind: "jar",
  };
}

test("validates names and updates server properties", () => {
  assert.equal(validateInstanceName("server-2"), "server-2");
  assert.throws(() => validateInstanceName("../server"), /Instance names/);
  assert.equal(setServerProperty("motd=old\nserver-port=1\n", "server-port", 25566), "motd=old\nserver-port=25566\n");
  assert.equal(setServerProperty("motd=old\n", "online-mode", "true"), "motd=old\nonline-mode=true\n");
});

test("builds safely quoted launch scripts", () => {
  assert.match(buildRunScript({ javaPath: JAVA_8, memory: "4G", kind: "jar", jar: "server.jar" }), /-Xms4G -Xmx4G/);
  assert.match(buildAdoptedRunScript("./start.sh", ["--nogui"]), /\/bin\/bash.*\.\/start\.sh.*--nogui/);
});

test("creates an empty draft and adopts a manual setup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-empty-"));
  try {
    const created = await createEmptyInstance({ root, name: "scratch", owner: null });
    assert.equal(created.manifest.state, "draft");
    assert.equal(created.manifest.port, null);
    assert.equal((await stat(created.directory)).mode & 0o777, 0o750);
    await assert.rejects(stat(path.join(root, "scratch", "run")));

    await writeFile(path.join(root, "scratch", "start.sh"), "#!/bin/sh\nexit 0\n", { mode: 0o750 });
    const adopted = await adoptInstance({
      root,
      name: "scratch",
      launch: "./start.sh",
      args: ["nogui"],
      port: 25566,
      owner: null,
    });
    assert.equal(adopted.manifest.state, "adopted");
    assert.equal(adopted.manifest.port, 25566);
    assert.match(await readFile(path.join(root, "scratch", "run"), "utf8"), /start\.sh.*nogui/);
    assert.match(await readFile(path.join(root, "scratch", "server.properties"), "utf8"), /server-port=25566/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes a draft staging directory when ownership fails", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "mcctl-draft-failure-"));
  const root = path.join(parent, "instances");
  try {
    await assert.rejects(
      createEmptyInstance({
        root,
        name: "broken",
        runCommand: async () => {
          throw new Error("simulated chown failure");
        },
      }),
      /simulated chown failure/,
    );
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects duplicate instances and launch paths outside an instance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-safety-"));
  try {
    await createEmptyInstance({ root, name: "safe", owner: null });
    await assert.rejects(createEmptyInstance({ root, name: "safe", owner: null }), /already exists/);
    await writeFile(path.join(root, "outside.sh"), "#!/bin/sh\n", { mode: 0o750 });
    await assert.rejects(
      adoptInstance({ root, name: "safe", launch: "../outside.sh", port: 25569, owner: null }),
      /inside the instance/,
    );
    await writeFile(path.join(root, "safe", "start.sh"), "#!/bin/sh\n", { mode: 0o750 });
    await assert.rejects(
      adoptInstance({ root, name: "safe", launch: "./start.sh", owner: null }),
      /requires --port/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("adopts the port already configured by a manual setup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-adopt-port-"));
  try {
    await createEmptyInstance({ root, name: "configured", owner: null });
    await writeFile(path.join(root, "configured", "start.sh"), "#!/bin/sh\n", { mode: 0o750 });
    await writeFile(path.join(root, "configured", "server.properties"), "server-port=25570\n");
    const result = await adoptInstance({ root, name: "configured", launch: "./start.sh", owner: null });
    assert.equal(result.manifest.port, 25570);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("creates a verified vanilla server atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-install-"));
  const body = Buffer.from("fake minecraft server jar");
  try {
    const result = await createResolvedInstance({
      root,
      name: "vanilla",
      resolved: resolvedVanilla(body),
      port: 25567,
      memory: "2G",
      acceptEula: true,
      javaPath: JAVA_8,
      javaResolver: async () => JAVA_8,
      owner: null,
      fetchImpl: async () => new Response(body, { status: 200 }),
    });
    assert.equal(result.manifest.state, "installed");
    assert.equal(result.manifest.artifact.sha256, createHash("sha256").update(body).digest("hex"));
    assert.equal(await readFile(path.join(root, "vanilla", "server.jar"), "utf8"), body.toString());
    assert.match(await readFile(path.join(root, "vanilla", "run"), "utf8"), /-Xms2G -Xmx2G/);
    assert.equal(await readFile(path.join(root, "vanilla", "eula.txt"), "utf8"), "eula=true\n");
    assert.equal((await readManifest(path.join(root, "vanilla"))).port, 25567);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("turns legacy Forge installer output into a pinned launcher", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-forge-"));
  const body = Buffer.from("fake forge installer");
  const forgeJar = "forge-1.12.2-14.23.5.2859-universal.jar";
  try {
    const result = await createResolvedInstance({
      root,
      name: "forge",
      resolved: {
        ...resolvedVanilla(body),
        requestedSpec: "1.12.2-forge",
        distribution: "forge",
        loaderVersion: "14.23.5.2859",
        artifact: {
          url: "https://example.test/installer.jar",
          sha1: createHash("sha1").update(body).digest("hex"),
          filename: "installer.jar",
        },
        installKind: "forge-installer",
      },
      port: 25569,
      javaPath: JAVA_8,
      javaResolver: async () => JAVA_8,
      owner: null,
      fetchImpl: async () => new Response(body, { status: 200 }),
      runCommand: async (command, args, options) => {
        assert.equal(command, JAVA_8);
        assert.deepEqual(args, ["-jar", "installer.jar", "--installServer"]);
        await writeFile(path.join(options.cwd, forgeJar), "fake forge server");
        return { stdout: "", stderr: "" };
      },
    });
    assert.deepEqual(result.manifest.launch, { kind: "jar", jar: forgeJar });
    assert.match(await readFile(path.join(root, "forge", "run"), "utf8"), new RegExp(forgeJar));
    await assert.rejects(stat(path.join(root, "forge", "installer.jar")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("keeps EULA file and manifest synchronized", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-eula-"));
  try {
    await createEmptyInstance({ root, name: "eula", owner: null });
    await setEula({ root, name: "eula", accepted: true, owner: null });
    assert.equal(await readFile(path.join(root, "eula", "eula.txt"), "utf8"), "eula=true\n");
    assert.equal((await readManifest(path.join(root, "eula"))).eulaAccepted, true);
    await writeFile(path.join(root, "eula", "eula.txt"), "eula=false\n");
    const report = await doctorInstance({ root, name: "eula" });
    assert.equal(report.eulaAccepted, false);
    assert.equal(report.checks.find((check) => check.name === "eula manifest").ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("removes staging data after checksum failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-failure-"));
  try {
    await assert.rejects(
      createResolvedInstance({
        root,
        name: "broken",
        resolved: resolvedVanilla(Buffer.from("expected"), "0".repeat(40)),
        port: 25568,
        javaPath: JAVA_8,
        javaResolver: async () => JAVA_8,
        owner: null,
        fetchImpl: async () => new Response(Buffer.from("wrong"), { status: 200 }),
      }),
      /SHA-1 mismatch/,
    );
    await assert.rejects(stat(path.join(root, "broken")));
    assert.equal((await (await import("node:fs/promises")).readdir(root)).length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("doctor reports incomplete drafts without touching services", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "mcctl-doctor-"));
  try {
    await createEmptyInstance({ root, name: "draft", owner: null });
    const report = await doctorInstance({ root, name: "draft" });
    assert.equal(report.ok, false);
    assert.equal(report.checks.find((check) => check.name === "launcher").ok, false);
    await writeFile(path.join(root, "draft", "run"), "#!/bin/sh\n", { mode: 0o640 });
    const nonExecutable = await doctorInstance({ root, name: "draft" });
    assert.equal(nonExecutable.checks.find((check) => check.name === "launcher").ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
