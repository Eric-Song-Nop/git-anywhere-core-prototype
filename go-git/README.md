# go-git browser core prototype

This directory pins `github.com/go-git/go-git/v5 v5.19.2` and builds a bare
Git core for `GOOS=js GOARCH=wasm`. It separates immutable Git objects from
mutable repository metadata:

- `globalThis.__gitObjectStore` is the resolved OpenDAL facade instance from
  `../rust-opendal/bridge.js`. It receives root-relative paths such as
  `repos/<repoId>/objects/<oid>` through `put/get/exists/size` Promise methods.
- `globalThis.__gitMetadataStore` supplies `snapshot(repoId)`,
  `initialize(repoId, initial)`, and `commit(repoId, mutation)` Promises. The
  Go bridge consumes the stable generation/revision CAS, direct-ref map,
  separate HEAD value, required-object preflight, and idempotency receipt
  contract from `../web/git-metadata-store.js`.

After Go's `wasm_exec.js` and `git-core.wasm` have started, Go publishes:

```js
const initial = await globalThis.__gitCore.init(repoId, { branch: "main" });
await globalThis.__gitCore.open(repoId);
await globalThis.__gitCore.createCommit(repoId, {
  branch: "main",
  idempotencyKey: "caller-owned-operation-id",
  expectedGeneration: initial.generation,
  expectedRevision: initial.revision,
  expectedBranchOid: null, // null/omitted means the branch must be absent
});
const state = await globalThis.__gitCore.readCommitState(repoId);
```

The exact integration order in a dedicated Worker is:

```js
// 1. Load the classic Go runtime before importing loader.js.
importScripts(new URL("../go-git/wasm_exec.js", self.location).href);

// 2. Install the path-only OpenDAL object facade. Root may contain `/`; every
//    later object key is repos/<repoId>/objects/<oid> beneath this root.
const { installGitObjectStore } = await import("../rust-opendal/bridge.js");
await installGitObjectStore("git-anywhere/core-v1");

// 3. Importing this module installs globalThis.__gitMetadataStore. It calls
//    __gitObjectStore.exists with the exact same path used by Go.
await import("../web/git-metadata-store.js");

// 4. Start Go last; loader.js checks both globals and resolves when __gitCore
//    has been published. Do not await `exited` during normal use: main stays
//    alive intentionally to retain syscall/js functions.
const { installGitCore } = await import("../go-git/loader.js");
const { core } = await installGitCore(new URL("../go-git/git-core.wasm", self.location));
```

Serve `.wasm` as `application/wasm`; the loader falls back from streaming
instantiation when the MIME type is wrong. Both the OpenDAL facade and metadata
store support Worker scope after the Rust compatibility shim is installed.
OPFS and IndexedDB are origin-scoped, so all module URLs must share one origin.

Every top-level function returns a JavaScript Promise immediately. Git work
runs in a Go goroutine; only that goroutine waits on backend Promises. A
blocking `syscall/js` callback must never await a Promise because it would
deadlock the JavaScript event loop.

`readCommitState` returns refs/HEAD plus all reachable objects as
`{type, oid, base64}` raw Git payloads. A canonical Git oracle can decode each
payload and run `git hash-object -w -t <type> --stdin`, compare every OID,
publish the exported refs, then run `git fsck --full`.

## Covered Storer surface

- Encoded loose object create/write/read/has/size. Each stored value is a
  versioned envelope containing type plus raw payload; every read recomputes
  and verifies the Git OID.
- Direct hash refs plus symbolic/detached HEAD. Single-ref writes and an
  explicit atomic branch+HEAD publication use metadata generation, revision,
  and expected-ref fences. Every non-deletion ref target is read and
  content-address verified before the metadata authority may publish it.
- Config and shallow state are metadata-backed. Config bytes are wrapped in a
  JSON-compatible `goGitConfigBase64` field at the JS boundary.
- Bare init/open and deterministic blob/tree/commit creation. Init derives its
  initial config and HEAD through `go-git`'s own bare initializer, then stores
  that state transactionally; it rejects an existing repository and reload
  never relies on in-memory refs.

## Explicit deferrals

- Object enumeration is unsupported because the immutable facade intentionally
  has no list method. Fetch/GC/repack paths that need enumeration are out of
  this proof.
- Packfile streaming, alternates, submodules, worktrees, and symbolic non-HEAD
  refs are unsupported.
- Index get/set are unsupported: this is a bare repository proof, and silently
  keeping a process-only index would violate reload semantics.
- `PackRefs` is a no-op because refs already live in a transactional metadata
  database; the backend has no loose-vs-packed distinction.
- Ordinary Storer calls generate keys from a cryptographically random
  per-WASM-process namespace plus a monotonic counter, so persisted receipts
  cannot collide after a Worker restart. The
  exported commit proof instead requires a caller-owned key so retry identity
  remains stable across worker/process restart. Callers should also replay the
  original `expectedGeneration`, `expectedRevision`, and expected branch OID;
  this preserves the exact mutation digest after an ambiguous successful
  response. Omitting the fence fields is only a first-attempt convenience.

## Build and test

```sh
./scripts/test.sh
./scripts/build.sh
```

Native tests cover deterministic commit/reopen, stale-generation/revision CAS,
object corruption detection, and explicit deferred surfaces. The test script
also compiles the exact `js/wasm` target.
