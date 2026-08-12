/**
 * Validate the environment before initializing the vendored OpenDAL 0.58.1
 * OPFS service. The source patch itself selects Window.navigator.storage or
 * WorkerGlobalScope.navigator.storage without modifying JavaScript globals.
 *
 * Keep this preflight so missing secure-context OPFS produces our structured
 * error instead of a lower-level Web API rejection. The function name stays
 * stable for the Go-WASM integration layer.
 */
export function installOpenDalWorkerNavigatorCompat(scope = globalThis) {
  if (!scope.navigator?.storage?.getDirectory) {
    const error = new Error("OPFS requires navigator.storage.getDirectory in a secure context");
    error.name = "GitObjectStoreError";
    error.code = "Unsupported";
    error.operation = "init";
    error.retryable = false;
    throw error;
  }
}
