import initWasm, { create_store } from "./pkg/git_object_store.js";
import { installOpenDalWorkerNavigatorCompat } from "./worker-compat.js";

/**
 * Initialize the Rust-WASM facade and publish the instance expected by the
 * go-git Go-WASM adapter.
 */
export async function installGitObjectStore(root, wasm = undefined) {
  installOpenDalWorkerNavigatorCompat(globalThis);
  await initWasm(wasm);
  const store = await create_store(root);
  globalThis.__gitObjectStore = store;
  return store;
}
