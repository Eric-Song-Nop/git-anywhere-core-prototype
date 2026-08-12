#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

"$project_dir/go-git/scripts/test.sh"

(
  cd "$project_dir/go-git"
  go vet ./...
  GOOS=js GOARCH=wasm CGO_ENABLED=0 go vet ./...
)

"$project_dir/rust-opendal/scripts/build.sh"
upstream_opfs="$HOME/.cargo/registry/src"
upstream_opfs="$(find "$upstream_opfs" -maxdepth 2 -type d -name 'opendal-service-opfs-0.58.1' -print -quit)"
if [[ -z "$upstream_opfs" ]]; then
  echo "opendal-service-opfs 0.58.1 is absent from the Cargo registry" >&2
  exit 1
fi
"$project_dir/rust-opendal/scripts/check-vendor.sh" "$upstream_opfs"
(
  cd "$project_dir/rust-opendal"
  cargo fmt --check
  cargo clippy --target wasm32-unknown-unknown --release --no-deps -- -D warnings
  cargo test --locked --target wasm32-unknown-unknown --no-run
)

node --check "$project_dir/web/git-metadata-store.js"
node --check "$project_dir/web/browser-tests.js"
node --check "$project_dir/web/run-browser-tests.mjs"
node --check "$project_dir/integration/page.js"
node --check "$project_dir/integration/worker.js"
node --check "$project_dir/integration/run-integration.mjs"
node --check "$project_dir/demo/app.js"
node --check "$project_dir/demo/git-object-view.js"
node --check "$project_dir/demo/worker.js"
node --check "$project_dir/demo/serve.mjs"
node --check "$project_dir/demo/run-browser-tests.mjs"

node "$project_dir/web/run-browser-tests.mjs"
node "$project_dir/integration/run-integration.mjs"
node --test "$project_dir/demo/git-object-view.test.mjs"
node "$project_dir/demo/run-browser-tests.mjs"
