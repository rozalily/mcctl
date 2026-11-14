#!/usr/bin/env bash
set -Eeuo pipefail

if ((EUID != 0)); then
    echo "Run this installer as root: sudo ./install.sh" >&2
    exit 1
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

if ! id minecraft >/dev/null 2>&1; then
    echo "Missing system account 'minecraft'; create it before installing mcctl." >&2
    exit 1
fi
if [[ ! -x /usr/bin/tmux ]]; then
    echo "Missing /usr/bin/tmux; install tmux before installing mcctl." >&2
    exit 1
fi
if [[ ! -x /usr/bin/sudo ]]; then
    echo "Missing /usr/bin/sudo; install sudo before installing mcctl." >&2
    exit 1
fi

install -d -m 0755 /usr/local/libexec/mcctl/lib
install -m 0644 "$source_dir/mcctl.mjs" /usr/local/libexec/mcctl/mcctl.mjs
install -m 0644 "$source_dir/lib/instances.mjs" /usr/local/libexec/mcctl/lib/instances.mjs
install -m 0644 "$source_dir/lib/specs.mjs" /usr/local/libexec/mcctl/lib/specs.mjs
install -m 0755 "$source_dir/mcctl" /usr/local/bin/mcctl

install -m 0755 "$source_dir/minecraft-supervisor" /usr/local/libexec/minecraft-supervisor
install -m 0755 "$source_dir/minecraft-launch" /usr/local/libexec/minecraft-launch
install -m 0755 "$source_dir/minecraft-stop" /usr/local/libexec/minecraft-stop
install -m 0755 "$source_dir/minecraft-console" /usr/local/bin/minecraft-console
install -m 0644 "$source_dir/minecraft@.service" /etc/systemd/system/minecraft@.service

install -d -o minecraft -g minecraft -m 0750 /srv/minecraft
install -d -m 0755 /etc/bash_completion.d
install -m 0644 "$source_dir/completions/mcctl.bash" /etc/bash_completion.d/mcctl

systemctl daemon-reload
echo "mcctl installed. Open a new Bash shell or source /etc/bash_completion.d/mcctl."