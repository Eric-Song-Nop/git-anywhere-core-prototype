/**
 * Start git-core.wasm after the caller has installed both backend globals.
 *
 * Classic `wasm_exec.js` must be loaded first (for example with importScripts
 * in a classic Worker, or as a side-effect module in Node/a bundler). This
 * helper accepts a URL, Response, ArrayBuffer, or precompiled WebAssembly.Module.
 */
export async function installGitCore(wasmSource = new URL("./git-core.wasm", import.meta.url)) {
  if (typeof globalThis.Go !== "function") {
    throw new Error("Go WASM runtime missing: load go-git/wasm_exec.js first");
  }
  for (const name of ["__gitObjectStore", "__gitMetadataStore"]) {
    if (globalThis[name] === undefined) {
      throw new Error(`globalThis.${name} must be installed before git-core.wasm starts`);
    }
  }

  const go = new globalThis.Go();
  let instantiated;
  if (wasmSource instanceof WebAssembly.Module) {
    instantiated = await WebAssembly.instantiate(wasmSource, go.importObject);
  } else if (wasmSource instanceof ArrayBuffer || ArrayBuffer.isView(wasmSource)) {
    instantiated = await WebAssembly.instantiate(wasmSource, go.importObject);
  } else {
    const response = wasmSource instanceof Response ? wasmSource : await fetch(wasmSource);
    if (!response.ok) throw new Error(`git-core.wasm fetch failed: ${response.status}`);
    try {
      instantiated = await WebAssembly.instantiateStreaming(response.clone(), go.importObject);
    } catch {
      instantiated = await WebAssembly.instantiate(await response.arrayBuffer(), go.importObject);
    }
  }

  const instance = instantiated instanceof WebAssembly.Instance ? instantiated : instantiated.instance;
  const exited = go.run(instance);
  await waitForGitCore();
  return { core: globalThis.__gitCore, exited };
}

async function waitForGitCore() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (globalThis.__gitCore !== undefined) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("git-core.wasm started but did not publish globalThis.__gitCore");
}
