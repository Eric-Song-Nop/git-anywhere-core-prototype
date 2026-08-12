#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
upstream_dir="${1:?usage: check-vendor.sh /path/to/opendal-service-opfs-0.58.1}"
vendor_dir="$project_dir/vendor/opendal-service-opfs"
patched_dir="$(mktemp -d)"
trap 'rm -rf -- "$patched_dir"' EXIT

cp -R "$upstream_dir/src" "$patched_dir/src"
cp "$upstream_dir/Cargo.toml" "$patched_dir/Cargo.toml"
cp "$upstream_dir/README.md" "$patched_dir/README.md"
cp "$upstream_dir/LICENSE" "$patched_dir/LICENSE"
cp "$upstream_dir/NOTICE" "$patched_dir/NOTICE"
patch -s -d "$patched_dir" -p1 < "$vendor_dir/worker-global-scope.patch"

diff -ru "$patched_dir/src" "$vendor_dir/src"
diff -u "$patched_dir/Cargo.toml" "$vendor_dir/Cargo.toml"
diff -u "$patched_dir/README.md" "$vendor_dir/README.md"
diff -u "$patched_dir/LICENSE" "$vendor_dir/LICENSE"
diff -u "$patched_dir/NOTICE" "$vendor_dir/NOTICE"
echo "vendor matches OpenDAL OPFS 0.58.1 plus worker-global-scope.patch"
