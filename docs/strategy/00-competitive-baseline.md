# Competitive baseline: wasm-git v0.0.17

<!-- markdownlint-disable MD013 -->

- Status: audited baseline for product and architecture decisions
- Audit date: 2026-08-12
- Upstream: [`petersalomonsen/wasm-git`](https://github.com/petersalomonsen/wasm-git)
- Pinned release: [`v0.0.17`](https://github.com/petersalomonsen/wasm-git/releases/tag/v0.0.17)
- Pinned commit: [`6250484764878a35ba374836465cbf2e54364994`](https://github.com/petersalomonsen/wasm-git/tree/6250484764878a35ba374836465cbf2e54364994)
- Pinned engine/toolchain: libgit2 1.9.4 and Emscripten 6.0.3

## Verdict

wasm-git is the current functional baseline for a usable browser Git client. It
already runs a real libgit2 engine in the browser, provides a working tree and
index, persists repositories in OPFS or IndexedDB, and performs real
clone/add/commit/fetch/merge/push workflows over Smart HTTP.

This repository is not a functional replacement for wasm-git. It is a
rigorous **storage architecture research prototype**: an executable contract
for keeping immutable Git objects separate from transactionally published
refs and repository metadata. It proves failure, race, retry, and restart
properties that wasm-git does not presently expose, but it intentionally lacks
the working tree, index, packs, remote protocols, and broad Git operations that
make wasm-git useful as a client.

The only sound reason to continue this line of work is a hard requirement for
one or more of the following:

- a non-filesystem object backend;
- indivisible multi-ref and metadata publication;
- stale-writer rejection across browser contexts;
- exact recovery after an ambiguous successful mutation; or
- bounded, auditable failure behavior beyond ordinary Git lockfiles.

If those are not requirements, use wasm-git and stop developing a separate Git
core.

## What wasm-git already wins

| Dimension             | Audited upstream capability                                                                                                                                                                                                                                                                                                                                                                    | Consequence                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Git engine            | wasm-git ships libgit2 1.9.4, not a partial JavaScript object parser. Its [`lg2` registry exposes 28 commands](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/libgit2patchedfiles/examples/lg2.c#L12-L41), including clone, add, checkout, commit, diff, fetch, merge, push, reset, revert, stash, status, tag, and index-pack.                     | It has a much broader functional base than this prototype.                                               |
| Repository model      | libgit2 operates on a conventional repository filesystem, including a working tree, index, loose objects, packs, refs, config, and repository state.                                                                                                                                                                                                                                           | Existing Git behavior composes naturally; the browser app does not have to recreate Git semantics.       |
| Browser persistence   | The release supports MEMFS, IDBFS, NODEFS, and OPFS. [The storage matrix is explicit](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/README.md#L194-L222).                                                                                                                                                                                          | A product can persist an ordinary repository today without inventing a storage layer.                    |
| OPFS deployment       | It ships pthread/WASMFS, JSPI, and Asyncify OPFS builds plus an automatic selector. JSPI and Asyncify do not require cross-origin isolation. [Upstream documents the bridge and selection order](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/README.md#L131-L167).                                                                               | OPFS and lack of COOP/COEP are no longer differentiators by themselves.                                  |
| End-to-end operations | Browser tests exercise clone, edit, add, commit, push, branch/reset/status/stash behavior, and remote round trips. The SAB-free suite proves clone/add/commit/push plus persistence after terminating and recreating its Worker. [See the OPFS test](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/test-browser-opfs-noniso/opfs.spec.js#L74-L93). | “Git runs in a browser” and “the repository survives a Worker restart” are solved baseline capabilities. |
| Remote transport      | Its custom browser transport implements Git Smart HTTP upload-pack and receive-pack endpoints. [The service routes are in the pinned transport](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/libgit2patchedfiles/src/transports/emscriptenhttp.c#L8-L13).                                                                                         | Clone, fetch, and push are real, not mocked.                                                             |
| Distribution          | The exact npm 0.0.17 package is 2,382,769 bytes compressed and 6,555,324 bytes unpacked because it contains every runtime variant. An application loads only one JS/WASM pair. Measured from the published tarball, the JSPI OPFS pair is about 968 KB raw and 390 KB gzip; the Asyncify OPFS pair is about 1.74 MB raw and 580 KB gzip.                                                       | Bundle size is an upstream strength. A competing runtime must measure before claiming an advantage.      |
| Release quality       | The exact release commit has green CI and publication workflows covering Node, browser Worker, main-thread Asyncify, all OPFS variants, loader selection, and the packed npm artifact. [Exact CI run](https://github.com/petersalomonsen/wasm-git/actions/runs/29567619203) and [publication run](https://github.com/petersalomonsen/wasm-git/actions/runs/29567618907).                       | It is maintained and release-tested, not an abandoned proof.                                             |

## Hard gaps worth competing on

These are architectural or reliability gaps. Adding another CLI verb does not
resolve them.

### 1. No application-facing object or metadata storage boundary

The published API gives libgit2 an Emscripten filesystem. It does not expose a
JavaScript object database, ref database, or storage-provider interface. Using
an object store or transactional key-value service therefore requires a new
filesystem implementation or new C/WASM bindings.

libgit2 itself has version-pinned system interfaces for a
[`git_odb_backend`](https://github.com/libgit2/libgit2/blob/v1.9.4/include/git2/sys/odb_backend.h#L27-L100)
and
[`git_refdb_backend`](https://github.com/libgit2/libgit2/blob/v1.9.4/include/git2/sys/refdb_backend.h#L60-L313),
but wasm-git does not export or integrate them. Making these hooks safe across
synchronous C calls and asynchronous browser storage is meaningful integration
work.

### 2. No cross-context transaction authority

wasm-git inherits ordinary filesystem and lockfile behavior. The build sets
libgit2 `THREADSAFE=OFF`; the pthread OPFS variant uses a thread to bridge the
filesystem, not to turn Git operations into a concurrent repository service.
[See the pinned build flags](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/emscriptenbuild/build.sh#L38-L50)
and
[`THREADSAFE=OFF`](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/emscriptenbuild/build.sh#L114).

There is no repository generation, revision CAS, expected-old-ref fence,
fenced lease, or persisted idempotency receipt. libgit2 has a reference
transaction API, but its own contract says queued updates are applied
“one by one” and processing stops at the first failure; it is not an atomic
application metadata transaction. [See libgit2 1.9.4's transaction
contract](https://github.com/libgit2/libgit2/blob/v1.9.4/include/git2/transaction.h#L99-L109).

### 3. The universal OPFS fallback is not crash-atomic

The JSPI and Asyncify variants keep a private MEMFS cache, recursively hydrate
it from OPFS on reopen, and mirror mutating calls back to OPFS. [The upstream
storage model is documented in its source](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/emscriptenbuild/library_opfs.js#L15-L32).

OPFS has no rename primitive in that layer, so rename is implemented as
recursive copy followed by delete. [See the implementation](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/emscriptenbuild/library_opfs.js#L297-L320).
A crash can therefore leave both paths, a partially replaced destination, or
a stale private cache. There is no documented or tested multi-tab invalidation
or writer-fencing protocol.

### 4. Remote pack traffic is whole-buffered and not cancellable

The browser XHR transport requests an `arraybuffer`, holds the complete
response, and copies it into WASM in chunks. For POST, each appended chunk
allocates and copies a new combined `Uint8Array` before one final send. [See
the XHR bridge](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/emscriptenbuild/post.js#L15-L67).

There is no `AbortSignal`, response-size limit, bounded queue, backpressure,
or structured retry contract. This makes very large or hostile packs a memory
and denial-of-service risk even though WebAssembly confines native memory
corruption to its linear-memory sandbox.

### 5. Production recovery behavior is not specified

Upstream tests orderly Worker recreation and repairs one known empty-directory
migration problem. It does not publish evidence for:

- crashing at every ref/object/index write boundary;
- quota exhaustion during a mutation;
- corrupted objects, refs, packs, or indexes at startup;
- two tabs racing one repository;
- exact response-loss retry after a successful mutation; or
- eviction and repair of origin-scoped storage.

These are the areas where this repository's fault, race, receipt, process
restart, object verification, and canonical Git oracle can contribute.

## Surface gaps

These are visible opportunities, but they can be implemented while retaining
wasm-git and libgit2.

| Surface           | Current limitation                                                                                                                                                                                                                                                | Correct interpretation                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Commands          | There is no direct `pull`, branch listing command, rebase, cherry-pick, fsck, gc/repack, sparse checkout, or full worktree management. Pull is composed as fetch plus merge in upstream examples.                                                                 | Mostly wrapper and maintenance work. GC/repack and quota-aware lifecycle are larger browser tasks.                         |
| Push              | The pinned [`push` wrapper](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/libgit2patchedfiles/examples/push.c#L17-L61) accepts no options and pushes only the current symbolic HEAD to `origin`.                      | Implement richer libgit2 bindings; do not replace the engine.                                                              |
| Commit            | The pinned [`commit` wrapper](https://github.com/petersalomonsen/wasm-git/blob/6250484764878a35ba374836465cbf2e54364994/libgit2patchedfiles/examples/commit.c#L17-L100) accepts only `-m` and a basic merge case.                                                 | Implement a typed commit API.                                                                                              |
| JavaScript API    | The primary interface is process-global FS/CWD/config plus string `callMain(argv)` and stdout/stderr capture. The OPFS loader adds only a small convenience facade.                                                                                               | Repository handles, typed results/errors, progress, cancellation, and operation serialization are high-value wrapper work. |
| Authentication    | The custom transport has no first-class per-operation credential/header callback. The upstream browser workaround is a global `XMLHttpRequest.open` monkey patch. [See issue #72](https://github.com/petersalomonsen/wasm-git/issues/72#issuecomment-1460483790). | Add an explicit credential provider and keep secrets out of stored config and logs.                                        |
| Protocols         | Browser remotes use the custom HTTP path. SSH is disabled, and the transport does not send a `Git-Protocol` request header for protocol v2.                                                                                                                       | Meaningful transport implementation, but not a new storage architecture.                                                   |
| Packaging         | There is no TypeScript declaration package or formal package `exports` map.                                                                                                                                                                                       | Straightforward distribution work.                                                                                         |
| Repository format | The release does not enable libgit2's experimental SHA-256 build mode.                                                                                                                                                                                            | A real compatibility roadmap item, not an immediate differentiator.                                                        |

## Constraints that are not competitive gaps

- **CORS:** a browser Git client cannot bypass the browser's origin policy.
  Same-origin routing or a CORS-enabled proxy/server remains necessary for any
  implementation.
- **Worker use for synchronous OPFS access:** this is a browser platform and
  synchronous-libgit2 integration constraint. The worker should be hidden
  behind a clean API, not advertised as eliminated.
- **Cross-origin isolation:** wasm-git's JSPI and Asyncify OPFS builds already
  remove this requirement. Only its fastest pthread build requires COOP/COEP.
- **Basic browser persistence:** wasm-git already persists a complete ordinary
  repository. A new implementation must offer stronger semantics, not merely a
  different persistence API.
- **Small bundles:** the selected wasm-git runtime is already compact. The
  current go-git plus OpenDAL proof is substantially larger and cannot claim a
  size advantage.

## Honest classification of this repository

The current repository is best described as an **executable transactional Git
storage contract**.

It has unusually strong evidence for its narrow scope:

- immutable object bytes are written and content-address verified before ref
  publication;
- refs, HEAD, config, shallow state, generation, revision, and receipts commit
  in one IndexedDB transaction;
- two same-fence writers produce one exact winner and one conflict;
- a response-loss retry returns the stored result without a second mutation;
- a separate browser process reopens exact state; and
- canonical Git reproduces every object ID and accepts the exported repository
  with strict fsck.

Those properties are described in [the architecture contract](../../ARCHITECTURE.md)
and exercised by [the integration harness](../../integration/README.md).

It is not a browser Git MVP because it is deliberately SHA-1, bare-only, and
fixed-operation. It has no general index/worktree mutation, pack streaming,
clone/fetch/push, reflogs, GC/repack, or server authority. Its go-git runtime
and OpenDAL module should be retained as research evidence until a spike proves
that the transaction contract can be integrated into the more capable
wasm-git/libgit2 baseline.

## Competitive decision

Use wasm-git v0.0.17 as the control implementation and functional core. Pursue
the transactional storage direction only as an extension that must prove it
can preserve wasm-git's feature breadth while adding a real storage and
concurrency guarantee. The proposed decision gate is defined in
[01-transactional-wasm-git-storage.md](01-transactional-wasm-git-storage.md).

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
