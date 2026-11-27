#!/usr/bin/env bash
set -Eeuo pipefail

server_jar=${1:?Usage: ./build.sh /path/to/craftbukkit.jar}
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
output=${2:-$source_dir/mcctl-bridge-renderer.jar}
java_bin=${JAVA_COMPILER_BIN:-$(command -v java || true)}
if [[ -z $java_bin || ! -x $java_bin ]]; then
    echo "Java with the jdk.compiler and jdk.jartool modules is required." >&2
    exit 1
fi
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
classes=$temporary/classes
manifest=$temporary/MANIFEST.MF
mkdir "$classes"
printf 'Manifest-Version: 1.0\n\n' > "$manifest"

"$java_bin" --module jdk.compiler/com.sun.tools.javac.Main \
    -source 8 -target 8 -Xlint:-options \
    -cp "$server_jar" \
    -d "$classes" \
    "$source_dir/src/dev/mcctl/bridge/McctlBridgeRenderer.java"
"$java_bin" --module jdk.jartool/sun.tools.jar.Main \
    --create --file "$output" --date=2026-01-01T00:00:00Z --manifest "$manifest" \
    -C "$classes" . \
    -C "$source_dir" plugin.yml