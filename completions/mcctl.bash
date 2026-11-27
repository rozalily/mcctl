_mcctl_commands="create adopt resolve doctor bridge list eula enable disable start stop restart status console help"
_mcctl_specs="latest-vanilla latest-fabric latest-forge latest-neoforge"

_mcctl_instances() {
    local root=${MCCTL_ROOT:-/srv/minecraft}
    local manifest_root=${MCCTL_MANIFEST_ROOT:-}
    local directory name
    if [[ -z $manifest_root ]]; then
        if [[ $root == /srv/minecraft ]]; then
            manifest_root=/etc/mcctl/instances
        else
            manifest_root=$root/.mcctl-manifests
        fi
    fi
    for directory in "$root"/*/; do
        [[ -d $directory ]] || continue
        name=${directory%/}
        name=${name##*/}
        [[ -f $manifest_root/$name.json ]] && printf '%s\n' "$name"
    done
}

_mcctl_spec_completions() {
    local current=$1
    local candidates=$_mcctl_specs
    local version

    if [[ $current =~ ^([0-9]+\.[0-9]+(\.[0-9]+)?)(-[a-z]*)?$ ]]; then
        version=${BASH_REMATCH[1]}
        candidates+=" $version-vanilla $version-fabric $version-forge $version-neoforge"
    fi
    COMPREPLY=( $(compgen -W "$candidates" -- "$current") )
}

_mcctl_positionals() {
    local index word skip=false
    MCCTL_POSITIONALS=()
    for ((index = 2; index < COMP_CWORD; index += 1)); do
        word=${COMP_WORDS[index]}
        if $skip; then
            skip=false
            continue
        fi
        case $word in
            --spec|--port|--memory|--java|--launch|--arg|--channel|--token-file|--command-style)
                skip=true
                ;;
            --spec=*|--port=*|--memory=*|--java=*|--launch=*|--arg=*|--channel=*|--token-file=*|--command-style=*|--*)
                ;;
            *)
                MCCTL_POSITIONALS+=("$word")
                ;;
        esac
    done
}

_mcctl_launchers() {
    local instance=$1
    local current=$2
    local root=${MCCTL_ROOT:-/srv/minecraft}
    local filename candidate
    [[ -n $instance && -d $root/$instance ]] || return
    for filename in "$root/$instance"/*; do
        [[ -f $filename ]] || continue
        candidate=./${filename##*/}
        [[ $candidate == "$current"* ]] && COMPREPLY+=("$candidate")
    done
}

_mcctl() {
    local current=${COMP_WORDS[COMP_CWORD]}
    local previous=${COMP_WORDS[COMP_CWORD - 1]}
    local command=${COMP_WORDS[1]}
    local options

    COMPREPLY=()
    if ((COMP_CWORD == 1)); then
        COMPREPLY=( $(compgen -W "$_mcctl_commands" -- "$current") )
        return
    fi

    _mcctl_positionals

    case $current in
        --spec=*)
            local spec=${current#--spec=}
            _mcctl_spec_completions "$spec"
            COMPREPLY=( "${COMPREPLY[@]/#/--spec=}" )
            return
            ;;
        --memory=*)
            local memory=${current#--memory=}
            COMPREPLY=( $(compgen -W "1G 2G 4G 6G 8G 12G 16G" -- "$memory") )
            COMPREPLY=( "${COMPREPLY[@]/#/--memory=}" )
            return
            ;;
    esac

    case $previous in
        --spec)
            _mcctl_spec_completions "$current"
            return
            ;;
        --memory)
            COMPREPLY=( $(compgen -W "1G 2G 4G 6G 8G 12G 16G" -- "$current") )
            return
            ;;
        --java|--token-file)
            if declare -F _filedir >/dev/null; then
                _filedir
            else
                COMPREPLY=( $(compgen -f -- "$current") )
            fi
            return
            ;;
        --launch)
            _mcctl_launchers "${MCCTL_POSITIONALS[0]}" "$current"
            return
            ;;
        --port|--arg)
            return
            ;;
        --channel)
            return
            ;;
        --command-style)
            COMPREPLY=( $(compgen -W "tellraw say broadcast" -- "$current") )
            return
            ;;
    esac

    case $command in
        create)
            options="--spec --port --memory --java --accept-eula --yes"
            if [[ $current == --* ]]; then
                COMPREPLY=( $(compgen -W "$options" -- "$current") )
            elif ((${#MCCTL_POSITIONALS[@]} == 1)); then
                _mcctl_spec_completions "$current"
            fi
            ;;
        adopt)
            options="--launch --arg --port --memory --java"
            if [[ $current == --* ]]; then
                COMPREPLY=( $(compgen -W "$options" -- "$current") )
            elif ((${#MCCTL_POSITIONALS[@]} == 0)); then
                COMPREPLY=( $(compgen -W "$(_mcctl_instances)" -- "$current") )
            fi
            ;;
        resolve)
            ((${#MCCTL_POSITIONALS[@]} == 0)) && _mcctl_spec_completions "$current"
            ;;
        bridge)
            options="--enable --disable --channel --token-file --command-style --announce --no-announce"
            if [[ $current == --* ]]; then
                COMPREPLY=( $(compgen -W "$options" -- "$current") )
            elif ((${#MCCTL_POSITIONALS[@]} == 0)); then
                COMPREPLY=( $(compgen -W "$(_mcctl_instances)" -- "$current") )
            fi
            ;;
        eula)
            if [[ $current == --* ]]; then
                COMPREPLY=( $(compgen -W "--accept --reject" -- "$current") )
            elif ((${#MCCTL_POSITIONALS[@]} == 0)); then
                COMPREPLY=( $(compgen -W "$(_mcctl_instances)" -- "$current") )
            fi
            ;;
        enable|disable)
            if [[ $current == --* ]]; then
                COMPREPLY=( $(compgen -W "--now" -- "$current") )
            elif ((${#MCCTL_POSITIONALS[@]} == 0)); then
                COMPREPLY=( $(compgen -W "$(_mcctl_instances)" -- "$current") )
            fi
            ;;
        doctor|start|stop|restart|status|console)
            ((${#MCCTL_POSITIONALS[@]} == 0)) && COMPREPLY=( $(compgen -W "$(_mcctl_instances)" -- "$current") )
            ;;
    esac
}

complete -F _mcctl mcctl