#!/usr/bin/env bash
set -Eeuo pipefail

server_jar=${1:?Usage: ./build.sh /path/to/craftbukkit.jar}
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
output=${2:-$source_dir/mcctl-bridge-renderer.jar}
java_bin=${JAVA_COMPILER_BIN:-/usr/lib/jvm/java-21-openjdk-amd64/bin/java}
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT

"$java_bin" --module jdk.compiler/com.sun.tools.javac.Main \
    -source 8 -target 8 -Xlint:-options \
    -cp "$server_jar" \
    -d "$temporary" \
    "$source_dir/src/dev/mcctl/bridge/McctlBridgeRenderer.java"
"$java_bin" --module jdk.jartool/sun.tools.jar.Main \
    --create --file "$output" \
    -C "$temporary" . \
    -C "$source_dir" plugin.yml