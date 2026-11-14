# mcctl

`mcctl` is an early-stage Minecraft server instance manager for Linux hosts using
systemd. It resolves Vanilla, Fabric, Forge, and NeoForge releases, verifies
downloads, selects the required Java runtime, and creates isolated server
directories under `/srv/minecraft`.

The project is private and host-oriented for now. Its command and manifest
formats may change before a public release.

## Features

- Optional specs such as `latest-vanilla`, `latest-fabric`, and
	`1.12.2-forge`
- Pinned loader versions such as `1.21.1-neoforge@21.1.224`
- Empty drafts for modpacks and custom launchers
- Atomic staging, publisher SHA-1 verification, and recorded SHA-256 hashes
- Exact Java-major detection without automatic package installation
- Explicit EULA acceptance
- Port-conflict, launcher, Java, and service health checks
- Generic systemd/tmux supervision and console access
- Bash completion for commands, options, specs, instances, and launch files

`mcctl` installs Minecraft and its loader only. It does not install arbitrary
mods or modpacks.

## Requirements

- Linux with systemd
- Node.js 22 or newer
- Bash, tmux, and sudo
- A `minecraft` system account
- Java runtimes appropriate for the Minecraft versions being hosted

The installer validates existing prerequisites but never installs packages.

## Install

Review the scripts, then run:

```bash
sudo ./install.sh
```

The installer places the CLI under `/usr/local/libexec/mcctl`, installs
`/usr/local/bin/mcctl`, registers `minecraft@.service`, and installs Bash
completion. Set `MCCTL_NODE=/absolute/path/to/node` when invoking `mcctl` if
Node is not available on the normal shell `PATH`.

## Usage

```bash
# Empty directory for a modpack or custom setup
mcctl create scratch

# Resolve, verify, and configure server software
mcctl create fabric-test latest-fabric --port 25566 --memory 4G
mcctl create old-forge 1.12.2-forge --port 25567 --memory 4G
mcctl create vanilla latest-vanilla --yes

# Turn an empty draft into a managed instance
mcctl adopt scratch --launch ./start.sh --port 25568

# EULA acceptance is always explicit
mcctl eula fabric-test --accept
mcctl doctor fabric-test
mcctl enable fabric-test --now
```

Useful operations:

```bash
mcctl resolve latest-fabric
mcctl list
mcctl status fabric-test
mcctl restart fabric-test
mcctl console fabric-test
mcctl stop fabric-test
mcctl disable fabric-test --now
```

An `external` entry in `mcctl list` is an existing server without an mcctl
manifest. It is not an error and does not require migration.

## Safety Model

Downloads stream into a temporary directory. When publishers provide SHA-1,
mcctl verifies it before installation; every artifact also receives a recorded
SHA-256. The final instance path appears only after setup succeeds. Instance
names and adopted launch paths are validated, and service startup is blocked
when doctor checks or EULA state fail.

Java and OS packages are never installed automatically. Missing runtimes stop
the operation with a package recommendation.

## Development

```bash
npm test
bash -n mcctl install.sh completions/mcctl.bash minecraft-*
```

Tests use Node's built-in test runner and deterministic HTTP/command fakes. No
runtime npm dependencies are required.

## Roadmap

- Configurable users, paths, and service names
- Backup timers and restore workflows
- Atomic upgrades and rollback
- Paper and Quilt resolvers
- Archive import with traversal-safe extraction
- Distribution packaging and a stable manifest schema
