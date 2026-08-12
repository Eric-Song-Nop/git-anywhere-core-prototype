# OpenDAL OPFS object facade

This crate is the Rust-WASM half of the Git Anywhere core-storage prototype.
It pins OpenDAL `0.58.1`, exports a deliberately narrow Promise API, and stores
only immutable Git object bytes in OPFS. Mutable refs and repository metadata
belong in the separate transactional metadata module.

## JavaScript API

```js
const store = await create_store("git-anywhere/repository-id/objects-v1");

await store.put("objects/ab/cdef", bytes); // number: byte length
await store.get("objects/ab/cdef");        // Uint8Array
await store.exists("objects/ab/cdef");     // boolean
await store.size("objects/ab/cdef");       // exact JS number
await store.remove("objects/ab/cdef");     // boolean; cleanup only
await store.clear();                        // cleanup only
```

`clear` removes all files but intentionally leaves empty directories. This
avoids an OpenDAL 0.58.1 OPFS recursive-root deletion failure and is sufficient
for deterministic object-store cleanup.

`put` is idempotent for identical bytes and rejects an existing different
value with `ImmutableConflict`. It serializes mutations through one store
instance and verifies bytes after writing. OPFS has no atomic create-if-absent,
so two independent workers/tabs can still race. Production content keys must be
derived from and independently verified against the Git object ID, and P0 has
one mutation-owning worker.

Rejected Promises contain an Error named `GitObjectStoreError` with:

- `code`: `InvalidPath`, `NotFound`, `NotAFile`, `ImmutableConflict`,
  `PermissionDenied`, `QuotaExceeded`, `RateLimited`, `Temporary`,
  `Unsupported`, `SizeOverflow`, or `Backend`;
- `operation`: `init`, `put`, `get`, `exists`, `size`, `remove`, or `clear`;
- `path` when one object key is involved;
- `retryable`: boolean.

Keys are relative slash-separated file paths. Empty/absolute paths, empty
segments, `.`/`..`, backslashes, NUL, and segments above 255 bytes are rejected.

## Build

Requirements: Rust with `wasm32-unknown-unknown`, and a `wasm-bindgen-cli`
matching the pinned Rust crate (`0.2.127`).

```sh
./scripts/build.sh
```

This produces the web-target artifacts in `pkg/`. `bridge.js` initializes them,
checks dedicated-Worker OPFS availability, and publishes the instance as
`globalThis.__gitObjectStore` for Go-WASM.

OpenDAL 0.58.1 asks `web_sys::window()` for `navigator.storage`, which traps in
a dedicated Worker even though WorkerNavigator exposes the same storage API.
The narrowly vendored service crate changes only that acquisition path: it
selects Window or the actual WorkerGlobalScope and never modifies JavaScript
globals or prototypes. `worker-compat.js` is only an early feature check. See
`vendor/opendal-service-opfs/PATCH.md`; remove the vendor once upstream supports
WorkerGlobalScope.

## Browser probe

After building, serve this directory at `http://127.0.0.1:4173` and open
`tests/browser/`. The worker probe covers binary round-trip, same-byte
idempotence, differing-byte conflict details, stat/exists, a full browser
process restart with the same profile, proof that no `Window` global was
installed in the Worker, and cleanup. `tests/browser_probe.py` automates that
probe with the Playwright version pinned in `tests/requirements.txt`.

Limitations: secure-context browser OPFS only; whole-object Uint8Array copies;
no range/chunk streaming; no cross-context create-if-absent; no rename/CAS; no
mutable refs; no deletion while objects are reachable; sizes above JS's exact
integer ceiling are rejected.
