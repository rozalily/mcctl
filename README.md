# mcctl

> **AI disclosure:** The making of this software used AI. I have been daily-driving it myself for a while and consider it stable, but if you are opposed to AI, you should not use it.

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
- Optional per-instance direct Discord chat bridge
- Bash completion for commands, options, specs, instances, and launch files

`mcctl` installs Minecraft and its loader only. It does not install arbitrary
mods or modpacks.

## Requirements

- Linux with systemd
- Node.js 22 or newer
- Bash, tmux, sudo, util-linux (`runuser`), and GNU coreutils
- Java runtimes appropriate for the Minecraft versions being hosted

The installer creates a locked `minecraft` system account and matching group
when absent. If the account already exists, it prints its UID, GID, home, and
shell, warns that it will be reused unchanged, and continues. The installer
validates other prerequisites but never installs packages. `/srv/minecraft` is
owned by root so the service account cannot create or replace instance roots;
individual instance directories remain owned by `minecraft`.

## Install

Once the repository is public, install the latest `main` version with either
download tool:

```bash
curl -fsSL https://raw.githubusercontent.com/rozalily/mcctl/main/bootstrap.sh | sudo bash
```

```bash
wget -qO- https://raw.githubusercontent.com/rozalily/mcctl/main/bootstrap.sh | sudo bash
```

The bootstrap downloads the source archive into a temporary directory, validates
the required installer files, runs `install.sh`, and removes the download. Pass
`--with-dashboard` through Bash to include the optional dashboard:

```bash
curl -fsSL https://raw.githubusercontent.com/rozalily/mcctl/main/bootstrap.sh | sudo bash -s -- --with-dashboard
```

While this repository remains private, GitHub requires authentication for both
the bootstrap and source archive. A local clone remains the simplest private
installation path.

To install from a clone, review the scripts, then run:

```bash
sudo ./install.sh
```

The installer places the CLI under `/usr/local/libexec/mcctl`, installs
`/usr/local/bin/mcctl`, registers `minecraft@.service`, and installs Bash
completion. Set `MCCTL_NODE=/absolute/path/to/node` when invoking `mcctl` if
Node is not available on the normal shell `PATH`.

### Optional Dashboard

The repository includes a read-only dashboard that automatically discovers
servers under `/srv/minecraft`. It is not installed by default.

```bash
sudo ./install.sh --with-dashboard
sudoedit /etc/default/mcctl-dashboard
sudo systemctl enable --now mcctl-dashboard.service
```

The dashboard binds to `127.0.0.1:3010` under `/status/`, records rolling
history under `/var/lib/mcctl-dashboard`, and runs as the `minecraft` account.
It should be exposed only through an authenticated reverse proxy. See
`dashboard/README.md` for configuration, legacy-server support, and an nginx
example.

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

### Discord Chat Bridge

The optional bridge directly connects an instance to one Discord text channel.
It uses Discord REST polling and opens no inbound command port. Store the bot
token in a private file, then enable and restart the instance:

```bash
printf '%s\n' 'YOUR_DISCORD_BOT_TOKEN' > ~/mcctl-discord.token
chmod 600 ~/mcctl-discord.token
mcctl bridge fabric-test --enable \
	--channel DISCORD_CHANNEL_ID \
	--token-file ~/mcctl-discord.token \
	--command-style tellraw
rm -f ~/mcctl-discord.token
mcctl restart fabric-test
```

Command styles are per instance:

- `tellraw` targets modern servers and supports exact Discord role colors.
- `say` targets an unmodified legacy server, with plain chat formatting.
- `broadcast` targets legacy Bukkit servers; mcctl installs a console-only
renderer plugin that displays Discord messages as direct `<display name> message`
chat without Bukkit's pink `[Server]` prefix. Names use the closest legacy color
to the member's highest colored Discord role; emoji, user mentions, role mentions,
and channel mentions are rendered as readable text. Custom guild emoji aliases
such as `:true:` are expanded for Discord. The renderer wraps long messages at
word boundaries using legacy font widths, and displays attachments as compact
`[filename]` labels instead of long CDN URLs. Minecraft `@username`, `@display name`,
and `@server nickname` text pings unique matching Discord members; `@everyone`,
`@here`, and role mentions remain disabled.

Run `mcctl bridge NAME` to inspect the current configuration. Any bridge config
change takes effect after `mcctl restart NAME`. Lifecycle messages are enabled by
default; use `--no-announce` or `--announce` to change them. Disable relay without
deleting its channel/token configuration with:

```bash
mcctl bridge fabric-test --disable
mcctl restart fabric-test
```

The bot needs View Channel, Read Message History, and Send Messages permissions.
Enable **Server Members Intent** on the bot's Discord Developer Portal page so
mcctl can resolve display names, server nicknames, and highest-role colors. mcctl
copies the token into `/etc/mcctl/bridges/NAME.token`; never place it directly on
the command line or in an instance manifest.

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

Only directories with valid root-owned metadata in
`/etc/mcctl/instances/<name>.json` are listed or managed. For an existing manual
setup, create an empty instance, copy its files into that directory, then run
`mcctl adopt` to record its launcher and settings.

## Safety Model

Downloads stream into a temporary directory. When publishers provide SHA-1,
mcctl verifies it before installation; every artifact also receives a recorded
SHA-256. The final instance path appears only after setup succeeds. Instance
names and adopted launch paths are validated, and service startup is blocked
when doctor checks or EULA state fail.

Trusted manifests are atomically written under `/etc/mcctl/instances`, outside
the service account's writable tree. Java probes, loader installers, and writes
to mutable server files run as `minecraft`; root is retained only for trusted
metadata, ownership setup, and systemd operations.

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
