#!/usr/bin/env bash
set -Eeuo pipefail

repository=${MCCTL_REPOSITORY:-rozalily/mcctl}
ref=${MCCTL_REF:-main}
archive_url=${MCCTL_ARCHIVE_URL:-https://api.github.com/repos/$repository/tarball/$ref}

if [[ ! $repository =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]]; then
    echo "Invalid MCCTL_REPOSITORY: $repository" >&2
    exit 2
fi
if [[ ! $ref =~ ^[A-Za-z0-9][A-Za-z0-9._/-]*$ || $ref == *..* ]]; then
    echo "Invalid MCCTL_REF: $ref" >&2
    exit 2
fi
if ! command -v tar >/dev/null 2>&1; then
    echo "Missing tar; install it before installing mcctl." >&2
    exit 1
fi

work_dir=$(mktemp -d -t mcctl-bootstrap.XXXXXXXX)
archive=$work_dir/mcctl.tar.gz
source_dir=$work_dir/source
cleanup() {
    rm -rf -- "$work_dir"
}
trap cleanup EXIT
mkdir -m 0700 "$source_dir"

echo "Downloading mcctl ($repository@$ref)..."
if command -v curl >/dev/null 2>&1; then
    curl_args=(--fail --silent --show-error --location --output "$archive")
    if [[ -n ${GITHUB_TOKEN:-} ]]; then
        curl_args+=(--header "Authorization: Bearer $GITHUB_TOKEN")
    fi
    curl "${curl_args[@]}" "$archive_url"
elif command -v wget >/dev/null 2>&1; then
    wget_args=(--quiet --output-document="$archive")
    if [[ -n ${GITHUB_TOKEN:-} ]]; then
        wget_args+=(--header="Authorization: Bearer $GITHUB_TOKEN")
    fi
    wget "${wget_args[@]}" "$archive_url"
else
    echo "Missing curl or wget; install one before installing mcctl." >&2
    exit 1
fi

if ! archive_listing=$(tar -tzf "$archive"); then
    echo "Downloaded mcctl archive is invalid." >&2
    exit 1
fi
if grep -Eq '(^/|(^|/)\.\.(/|$))' <<<"$archive_listing"; then
    echo "Downloaded mcctl archive contains unsafe paths." >&2
    exit 1
fi

tar -xzf "$archive" -C "$source_dir" --strip-components=1 --no-same-owner --no-same-permissions
for required in install.sh mcctl.mjs lib/instances.mjs lib/specs.mjs; do
    if [[ ! -f $source_dir/$required ]]; then
        echo "Downloaded mcctl archive is missing $required." >&2
        exit 1
    fi
done

echo "Running mcctl installer..."
/bin/bash "$source_dir/install.sh" "$@"
