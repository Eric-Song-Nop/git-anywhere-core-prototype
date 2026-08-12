# Git Anywhere core-storage prototype

This is a deliberately small proof that a real Git core can run in a browser
without treating remote object storage as a POSIX filesystem.

```text
go-git v5.19.2 (Go-WASM, bare repository)
  ├─ immutable encoded objects
  │    └─ Promise bridge → OpenDAL 0.58.1 (Rust-WASM) → OPFS
  └─ mutable refs / HEAD / config / shallow state
       └─ one IndexedDB read/write transaction + idempotency receipt
```

All repository work runs in one dedicated Worker. JavaScript-facing Go
callbacks return Promises immediately, while Go goroutines await the async
Rust and IndexedDB backends. Objects are written and hash-verified before a
generation/revision/old-ref CAS may publish them through refs.

## Reproduce

Requirements used for the recorded run:

- Go 1.26.5;
- Rust/Cargo 1.96.0 with `wasm32-unknown-unknown`;
- `wasm-bindgen-cli` 0.2.127;
- Node.js 26.7.0;
- Chrome for Testing 151.0.7922.34;
- canonical Apple Git 2.50.1.

Run every build, unit/contract check, two-process Chromium persistence test,
and canonical Git oracle:

```sh
./scripts/test-all.sh
```

Or run the final cross-module proof after building both WASM modules:

```sh
./rust-opendal/scripts/build.sh
./go-git/scripts/build.sh
node integration/run-integration.mjs
```

## Try the storage lab

The repository also includes a deliberately small, no-framework browser UI
for inspecting the same core contract:

```sh
./rust-opendal/scripts/build.sh
./go-git/scripts/build.sh
node demo/serve.mjs
```

Open <http://127.0.0.1:4173/demo/>. The lab can initialize or reopen a bare
repository, publish the deterministic proof commit, race two same-fence
writers, and reload into a new page and Worker to verify exact persisted
revision, refs, HEAD, and reachable object bytes. Its two storage lanes make
the split explicit: immutable Git objects flow through OpenDAL into OPFS,
while IndexedDB owns atomic refs, HEAD, and revision publication. The reset
control removes demo metadata only; immutable OPFS bytes intentionally remain.
The repository panel also decodes the commit and root tree into the logical
`proof.txt → blob` relationship, while explicitly remaining bare-only.

See [demo/README.md](demo/README.md) for the interaction and test details.

The final harness launches two sequential, fully separate Chromium processes
with one profile and origin. It proves:

- two same-fence writers yield exactly one winner and one conflict;
- retrying the winner's original idempotency key and original fence returns
  the exact stored receipt without advancing the revision;
- a new Worker in a new browser process reopens identical refs, HEAD, and
  blob/tree/commit bytes from IndexedDB plus OPFS;
- canonical Git independently reproduces all object IDs and accepts the
  exported repository with `git fsck --full --strict`.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the publication rule and explicit
P0 boundary, and each component README for its API and standalone tests.

## Non-goals

This is not a filesystem emulator or a production hosting service. P0 is
SHA-1 and bare-only. Worktrees/index, pack streaming, fetch/push, reflogs,
GC/repack, cross-Worker immutable create-if-absent, and a server metadata
authority are intentionally deferred.
