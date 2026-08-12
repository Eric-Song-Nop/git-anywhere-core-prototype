#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$project_dir"

actual_wasm_bindgen="$(wasm-bindgen --version | awk '{print $2}')"
expected_wasm_bindgen="$(
  sed -n 's/^wasm-bindgen = "=\([^"]*\)"$/\1/p' Cargo.toml
)"
if [[ "$actual_wasm_bindgen" != "$expected_wasm_bindgen" ]]; then
  echo "wasm-bindgen CLI $actual_wasm_bindgen does not match crate $expected_wasm_bindgen" >&2
  exit 1
fi

cargo build --locked --release --target wasm32-unknown-unknown
wasm-bindgen \
  --target web \
  --out-dir pkg \
  --out-name git_object_store \
  target/wasm32-unknown-unknown/release/git_anywhere_opendal.wasm
