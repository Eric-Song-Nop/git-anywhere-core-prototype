import { installGitObjectStore } from "../../bridge.js";

const root = "git-anywhere-browser-test/objects-v1";
const key = "objects/aa/immutable-object";
const first = new Uint8Array([0, 1, 2, 127, 128, 255]);
const mode = new URL(self.location.href).searchParams.get("mode") ?? "write";

async function capturedError(action) {
  try {
    await action();
    return undefined;
  } catch (error) {
    return {
      code: error.code,
      name: error.name,
      operation: error.operation,
      path: error.path,
      retryable: error.retryable,
    };
  }
}

try {
  const store = await installGitObjectStore(root);
  const windowGlobalUnmodified = typeof self.Window === "undefined";
  if (mode === "write") {
    await store.clear();

    const written = await store.put(key, first);
    const idempotent = await store.put(key, first);
    const loaded = await store.get(key);
    const exists = await store.exists(key);
    const size = await store.size(key);

    const conflict = await capturedError(() =>
      store.put(key, new Uint8Array([9])),
    );
    const missing = await capturedError(() => store.get("objects/ff/missing"));
    const invalid = await capturedError(() => store.get("../escape"));

    postMessage({
      mode,
      ok:
        written === first.length &&
        idempotent === first.length &&
        exists &&
        size === first.length &&
        loaded.length === first.length &&
        loaded.every((byte, index) => byte === first[index]) &&
        conflict?.code === "ImmutableConflict" &&
        missing?.code === "NotFound" &&
        invalid?.code === "InvalidPath" &&
        windowGlobalUnmodified,
      conflict,
      exists,
      idempotent,
      invalid,
      missing,
      size,
      written,
      windowGlobalUnmodified,
    });
  } else if (mode === "reopen") {
    const loaded = await store.get(key);
    const size = await store.size(key);
    const removed = await store.remove(key);
    const removedAgain = await store.remove(key);
    await store.clear();

    postMessage({
      mode,
      ok:
        size === first.length &&
        loaded.length === first.length &&
        loaded.every((byte, index) => byte === first[index]) &&
        removed &&
        !removedAgain &&
        windowGlobalUnmodified,
      removed,
      removedAgain,
      size,
      windowGlobalUnmodified,
    });
  } else {
    throw new Error(`unknown browser probe mode: ${mode}`);
  }
} catch (error) {
  postMessage({
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      name: error.name,
      operation: error.operation,
      path: error.path,
      stack: error.stack,
    },
  });
}
