#!/usr/bin/env bash
set -Eeuo pipefail

ensure_minecraft_account() {
    local id_bin=${MCCTL_ID_BIN:-/usr/bin/id}
    local getent_bin=${MCCTL_GETENT_BIN:-/usr/bin/getent}
    local useradd_bin=${MCCTL_USERADD_BIN:-/usr/sbin/useradd}
    local nologin_bin=${MCCTL_NOLOGIN_BIN:-/usr/sbin/nologin}
    local entry uid gid home shell
    local -a group_args=(--user-group)

    if [[ ! -x $id_bin || ! -x $getent_bin ]]; then
        echo "Missing required account tools: id and getent." >&2
        return 1
    fi

    if "$id_bin" minecraft >/dev/null 2>&1; then
        entry=$("$getent_bin" passwd minecraft) || {
            echo "Account 'minecraft' exists but has no passwd entry." >&2
            return 1
        }
        IFS=: read -r _ _ uid gid _ home shell <<<"$entry"
        echo "Warning: account 'minecraft' already exists (uid=$uid gid=$gid home=$home shell=$shell); leaving it unchanged." >&2
    else
        if [[ ! -x $useradd_bin || ! -x $nologin_bin ]]; then
            echo "Missing required account tools: useradd and nologin." >&2
            return 1
        fi
        if "$getent_bin" group minecraft >/dev/null 2>&1; then
            group_args=(--gid minecraft)
        fi
        "$useradd_bin" --system "${group_args[@]}" --home-dir /srv/minecraft --create-home --shell "$nologin_bin" minecraft
        echo "Created system account 'minecraft' with home /srv/minecraft."
    fi

    if ! "$getent_bin" group minecraft >/dev/null 2>&1; then
        echo "A group named 'minecraft' is required by minecraft@.service." >&2
        return 1
    fi
}

main() {
    if ((EUID != 0)); then
        echo "Run this installer as root: sudo ./install.sh" >&2
        exit 1
    fi

    local source_dir
    source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

    ensure_minecraft_account
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
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    main "$@"
fi