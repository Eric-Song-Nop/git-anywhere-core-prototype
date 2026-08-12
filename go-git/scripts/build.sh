#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"

cd "$project_dir"
GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -trimpath -o git-core.wasm .
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" wasm_exec.js
printf 'built %s bytes (gzip -9: ' "$(wc -c < git-core.wasm | tr -d ' ')"
gzip -9 -c git-core.wasm | wc -c | tr -d ' '
printf ' bytes)\n'
