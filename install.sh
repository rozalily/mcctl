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

install_dashboard() {
    local source_dir=$1
    local prefix=${MCCTL_DESTDIR:-}
    local target=$prefix/usr/local/libexec/mcctl-dashboard
    local config=$prefix/etc/default/mcctl-dashboard

    install -d -m 0755 "$target/lib" "$target/public/fonts" "$target/public/vendor/skinview3d"
    install -m 0644 "$source_dir/dashboard/server.mjs" "$target/server.mjs"
    install -m 0644 "$source_dir/dashboard/lib/"*.mjs "$target/lib/"
    install -m 0644 "$source_dir/dashboard/public/index.html" "$target/public/index.html"
    install -m 0644 "$source_dir/dashboard/public/app.js" "$target/public/app.js"
    install -m 0644 "$source_dir/dashboard/public/styles.css" "$target/public/styles.css"
    install -m 0644 "$source_dir/dashboard/public/favicon.svg" "$target/public/favicon.svg"
    install -m 0644 "$source_dir/dashboard/public/fonts/"* "$target/public/fonts/"
    install -m 0644 "$source_dir/dashboard/public/vendor/skinview3d/"* "$target/public/vendor/skinview3d/"
    install -m 0755 "$source_dir/dashboard/run" "$target/run"
    install -d -m 0755 "$prefix/etc/systemd/system"
    install -m 0644 "$source_dir/dashboard/mcctl-dashboard.service" "$prefix/etc/systemd/system/mcctl-dashboard.service"

    if [[ -n $prefix ]]; then
        install -d -m 0750 "$prefix/var/lib/mcctl-dashboard"
    else
        install -d -o minecraft -g minecraft -m 0750 /var/lib/mcctl-dashboard
    fi
    install -d -m 0755 "$prefix/etc/default"
    if [[ ! -e $config ]]; then
        install -m 0644 "$source_dir/dashboard/mcctl-dashboard.env.example" "$config"
    else
        echo "Warning: preserving existing $config." >&2
    fi

    echo "Dashboard installed but not started. Review /etc/default/mcctl-dashboard, then run:"
    echo "  systemctl enable --now mcctl-dashboard.service"
}

main() {
    local with_dashboard=false
    while (($#)); do
        case $1 in
            --with-dashboard)
                with_dashboard=true
                ;;
            --help|-h)
                echo "Usage: sudo ./install.sh [--with-dashboard]"
                return
                ;;
            *)
                echo "Unknown installer option: $1" >&2
                return 2
                ;;
        esac
        shift
    done

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

    if $with_dashboard; then
        install_dashboard "$source_dir"
    fi
    systemctl daemon-reload
    echo "mcctl installed. Open a new Bash shell or source /etc/bash_completion.d/mcctl."
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
    main "$@"
fi