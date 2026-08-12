# Product hypothesis: transactional storage beneath wasm-git

<!-- markdownlint-disable MD013 -->

- Status: proposed, conditional on a hard product requirement
- Functional control: wasm-git v0.0.17 at `6250484764878a35ba374836465cbf2e54364994`
- Storage-contract reference: this repository at `73bcbfee3507376624feb3865e214a3c7cc1a1a8`

## Decision statement

Do not build another browser Git engine. Keep wasm-git/libgit2 as the engine
and investigate a transaction-aware storage and repository-authority layer
beneath a typed JavaScript API.

The work is justified only if the product requires correctness that stock
wasm-git plus an ordinary OPFS repository cannot provide. The first decision
gate is a bounded two-week spike. Until that spike passes, the current
go-git/OpenDAL implementation remains research evidence rather than a product
runtime.

## Target user and job

The initial segment is deliberately narrower than “browser Git.” The target is
an engineer operating a **non-cross-origin-isolated browser application** whose
repositories have at least 1 GiB of reachable Git data and 100,000 objects, and
whose users may reopen or mutate one repository from more than one cooperating
tab or Worker. The relevant `wasm-git` controls are therefore its current JSPI
and Asyncify OPFS variants. If the application can deploy COOP/COEP, the pthread
WASMFS variant must also be measured and may invalidate the opportunity.

Before implementation, one named design partner must supply an anonymizable
repository-shape report, a reproducible cold-open or competing-context failure,
the browser/deployment constraints that prevent a simpler solution, and an
engineer who will evaluate the spike. Without that evidence, this direction
stays `STOP` rather than becoming a generic runtime project.

The job to be done is:

> Maintain interoperable committed Git history in the browser, allow ordinary
> remote synchronization, and preserve one unambiguous authoritative object/ref
> state across reloads, crashes, retries, and competing tabs without hydrating
> the full Git object database into a private in-memory filesystem.

The guarantee is intentionally limited to committed Git objects, packs, refs,
HEAD, and the publication receipt. A dirty worktree and index are not silently
included in that claim. An application must either persist unsaved editor state
separately or accept ordinary working-copy recovery semantics.

This direction is a fit when at least one of these is mandatory:

- objects or packs must live behind a non-filesystem storage provider;
- more than one browser context may attempt to mutate a repository;
- a mutation must publish multiple refs or metadata fields indivisibly;
- a caller must safely retry after losing the success response; or
- the application needs auditable crash and stale-writer behavior.

It is not aimed at:

- replacing the Git CLI;
- building a browser Git hosting server;
- reproducing every porcelain command independently of libgit2;
- treating IndexedDB as a remote multi-user server authority; or
- adding UI, agents, collaboration flows, or IDE features.

## Required invariants

Any custom path must preserve all of these before it can replace stock OPFS
storage for a mutation:

1. **Reachability:** no published ref or detached HEAD points to an absent,
   truncated, wrong-type, or wrong-OID object.
2. **One winner:** two operations with the same generation, revision, and
   expected ref state produce at most one publication.
3. **Atomic metadata:** all requested ref, HEAD, and owned metadata changes are
   visible together or not at all.
4. **No ABA after reset:** a new repository generation rejects every mutation
   captured from an earlier incarnation, even if its revision and refs happen
   to match.
5. **Exact retry:** retrying the same operation ID, digest, and fence returns
   the exact persisted result without advancing state again.
6. **Fail-closed corruption:** a read whose bytes do not reproduce its Git OID
   fails before publication.
7. **Bounded work:** storage, network, and WASM memory have explicit limits and
   cancellation points.
8. **Git compatibility:** exported reachable state reproduces canonical Git
   object IDs and passes `git fsck --full --strict`.

## Proposed architecture

```text
application
  └─ typed RepositoryClient (Promise API, AbortSignal, progress, auth)
       └─ RepositoryAuthority (one serialized mutation lane per repo)
            ├─ wasm-git / libgit2 1.9.4 WASM
            │    ├─ worktree + index cache → OPFS filesystem
            │    ├─ custom ODB bridge
            │    │    └─ immutable objects/packs → storage provider
            │    └─ transaction-aware refdb bridge
            │         └─ staged ref journal → metadata transaction
            ├─ metadata authority → IndexedDB
            │    refs, HEAD, generation, revision, receipts, leases
            └─ Smart HTTP transport
                 bounded streaming, cancellation, auth, quarantine
```

The architecture has three distinct roles:

- **libgit2 owns Git semantics.** It parses and writes objects, indexes packs,
  calculates merges and status, manages the index, and speaks Git protocols.
- **The storage layer owns durability.** Immutable object and pack bytes can be
  written before publication. A strong metadata store owns reachability,
  generations, revisions, and receipts.
- **The repository authority owns concurrency.** It serializes local work,
  captures a fence before a mutation, and is the only component allowed to
  publish the staged ref journal.

The browser implementation should initially retain an OPFS worktree and index.
They are caches protected by the repository authority, not the authority for
shared refs. Each cache records the authoritative generation and revision from
which it was built. After a crash, stale context, or accepted publication, a
mismatched cache is invalidated and rebuilt before another Git operation; it is
never used to infer authoritative refs. The spike must terminate after cache
writes and before metadata publication and prove either prior-state rebuild or
complete accepted-state rebuild. Moving index/config/shallow state into the
metadata database is a later decision that needs a concrete transactional use
case.

## Integration option A: stock wasm-git plus Web Locks

Use the exact upstream OPFS auto-loader and acquire one exclusive
[Web Lock](https://w3c.github.io/web-locks/) for every operation that opens or
mutates a repository:

```js
await navigator.locks.request(`git-repository:${repoId}`, async () => {
  return repository.run(operation);
});
```

Also keep an in-Worker queue because callers in one context can issue
overlapping Promises.

### What this option proves quickly

- the application can hide Worker, FS, CWD, and stdout mechanics behind a
  repository-handle API;
- cooperating same-origin tabs and workers do not concurrently invoke
  libgit2 on the same repository;
- the complete upstream clone/edit/add/commit/push path stays intact; and
- stock wasm-git establishes the functional and performance control for every
  later comparison.

### Limits

Web Locks are cooperative, origin-scoped, and not durable transaction fences.
They do not add:

- a revision or expected-old-ref CAS;
- exact response-loss idempotency;
- atomic refs plus application metadata;
- object publication into a non-filesystem backend;
- protection from code that ignores the lock; or
- a recovery record explaining whether an interrupted mutation committed.

This option is the correct endpoint if one cooperative writer at a time is the
only requirement. It is a baseline, not a disguised justification for the
custom storage project.

## Integration option B: custom libgit2 ODB/refdb bridges

libgit2 1.9.4 exposes a
[`git_odb_backend`](https://github.com/libgit2/libgit2/blob/v1.9.4/include/git2/sys/odb_backend.h#L27-L100)
with object read/write/stream/writepack hooks and a
[`git_refdb_backend`](https://github.com/libgit2/libgit2/blob/v1.9.4/include/git2/sys/refdb_backend.h#L60-L313)
with lookup, iteration, write, rename, delete, and ref-lock hooks. These are
advanced, version-pinned C interfaces; wasm-git does not currently bind them.

The bridge must run inside a Worker and suspend synchronous libgit2 calls while
awaiting browser storage through JSPI or Asyncify. It must not expose an async
callback that returns before libgit2 believes an object or ref operation is
complete.

### ODB behavior

- Store loose objects by algorithm and OID in an immutable namespace.
- Recompute the OID on every untrusted or persisted read.
- Make a repeated write of identical bytes succeed and a different value at
  the same key fail.
- Implement bounded read/write streams and `writepack`; a loose-object-only
  proof is not enough to support clone/fetch.
- Write incoming packs and indexes to a quarantine generation. Make them
  readable to the active operation, but do not publish remote refs until pack
  verification and metadata commit succeed.
- Defer deletion and GC until a generation/manifest design can prove that no
  reachable reader needs the bytes.

### Refdb behavior

A refdb callback must not commit each ref directly. It should read from the
operation's captured snapshot and record intended writes, renames, deletes,
and reflog effects in an in-memory mutation journal.

At the high-level operation boundary, the repository authority:

1. captures generation, revision, and expected refs;
2. runs libgit2 against the custom ODB and transaction-aware refdb;
3. awaits and verifies every required object or pack;
4. validates the complete staged ref journal;
5. publishes refs, HEAD, revision, and the idempotency receipt in one
   IndexedDB transaction; and
6. returns only the receipt-stored result.

If libgit2's call graph cannot provide a reliable operation boundary or the
refdb lock/unlock lifecycle cannot be mapped to one staged journal without
patching libgit2 internals, the custom option fails its spike.

### Why this option is harder

- libgit2's callbacks are synchronous while browser storage is asynchronous;
- stock ref transactions do not provide application-level all-or-nothing
  multi-ref publication;
- clone/fetch needs pack streaming and `writepack`, not only loose objects;
- worktree/index writes still require one repository authority; and
- every wasm-git/libgit2 upgrade must replay the backend contract tests.

The complexity is warranted only by a hard storage or transaction requirement.

## Storage and publication model

The initial model should preserve the proven split:

```text
immutable byte plane
  repos/<repo-id>/objects/<algorithm>/<oid>
  repos/<repo-id>/packs/<pack-checksum>/<immutable files>

metadata authority (one IndexedDB read/write transaction)
  repository: generation, revision, refs, HEAD, active pack manifest
  receipt: operation id, mutation digest, exact result
```

Publication order is strict:

1. Write object or quarantined pack bytes.
2. Flush/close and verify their content identities.
3. Build the complete ref and manifest mutation.
4. In one metadata transaction, validate operation identity, generation,
   revision, expected refs, and object readiness.
5. Commit the new state and exact receipt.
6. Treat a lost response as ambiguous; retry the original operation identity
   and fence instead of inventing a new mutation.

A crash before step 5 may leave unreachable immutable bytes. That is safe and
later GC can collect them. A crash after step 5 is recovered from the receipt.

## Reusable and discarded assets

“Discarded” means excluded from the candidate product runtime, not deleted
from this research repository.

| Asset                                                                       | Decision                                          | Rationale                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| wasm-git libgit2/Emscripten build and release packaging                     | Reuse                                             | It is the functional engine and distribution baseline.                                                                                    |
| wasm-git OPFS variants and auto-loader                                      | Reuse for option A and as the performance control | They already solve worker deployment and no-isolation fallback.                                                                           |
| wasm-git command implementations and browser remote tests                   | Reuse                                             | They preserve working Git behavior while storage changes underneath.                                                                      |
| This repository's IndexedDB generation/revision/ref CAS                     | Reuse contract and tests                          | It is the strongest differentiated result. Generalize its schema only after the spike.                                                    |
| Idempotency digest and exact receipt behavior                               | Reuse                                             | It closes the response-loss ambiguity that a Web Lock does not.                                                                           |
| Fault injection, two-writer race, process restart, and canonical Git oracle | Reuse and expand                                  | These are acceptance infrastructure, not engine-specific product code.                                                                    |
| OpenDAL OPFS object facade                                                  | Conditional reuse                                 | Keep it if backend portability is required and its extra WASM/copy cost passes the budget. Prefer direct OPFS if OPFS is the only target. |
| OpenDAL WorkerGlobalScope patch                                             | Conditional reuse                                 | Remove it when upstream supports WorkerGlobalScope or if OpenDAL leaves the runtime.                                                      |
| go-git v5 WASM core                                                         | Discard from the candidate runtime                | wasm-git is smaller and functionally broader. Retain it only as an independent oracle/prototype reference.                                |
| Fixed deterministic `createCommit` API                                      | Discard                                           | It is test scaffolding, not a general repository API.                                                                                     |
| Storage Lab UI                                                              | Discard from core runtime                         | Keep only as a teaching/debugging artifact. It is not product evidence.                                                                   |
| Bare-only and no-enumeration assumptions                                    | Discard                                           | The target must support an ordinary working repository and packs.                                                                         |

## Threat and failure model

The design protects repository correctness and availability. It does not try
to isolate mutually hostile scripts already running in the same origin; those
scripts already share the browser storage authority.

| Event or actor                                           | Required behavior                                                                                                                                                |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Two cooperating tabs mutate one repo                     | Option A serializes them with one Web Lock. Option B additionally fences state so one exact publication wins.                                                    |
| Stale Worker resumes after reset/reinitialize            | Its old generation is rejected even if revision and refs match.                                                                                                  |
| Crash before object durability                           | No metadata publication occurs. The prior state remains authoritative.                                                                                           |
| Crash after object durability but before metadata commit | Only unreachable immutable bytes may remain.                                                                                                                     |
| Crash after commit but before response                   | The same operation ID and digest returns the exact stored result.                                                                                                |
| Quota exhaustion or permission denial                    | Fail before publication, preserve prior refs, return a typed non-retryable or policy-qualified error.                                                            |
| OPFS partial write or corrupted persisted object         | OID verification fails closed; no ref may make it reachable.                                                                                                     |
| Network loss during fetch/push                           | Abort and close bounded streams. Quarantined data remains unreachable; retry does not publish partial refs.                                                      |
| Malicious or unexpectedly large remote                   | Enforce advertised and received byte/object limits, bounded queues, timeouts, and `AbortSignal`. WASM containment does not prevent memory/CPU denial of service. |
| Remote rejects push as stale/non-fast-forward            | Report the server result. Local IndexedDB is not a substitute for server-side ref authority.                                                                     |
| Credential use                                           | Supply credentials per operation through a callback; never persist them in repo config, receipts, logs, or error strings.                                        |
| Browser storage eviction                                 | Detect missing/corrupt state and fail closed. Recovery is re-fetch/reclone or an application backup; origin storage is not a sole durable backup.                |
| Same-origin malicious script                             | Out of scope as an isolation boundary. Add application encryption only for a separately defined confidentiality requirement.                                     |

## Two-week decision spike

The spike starts only after the design-partner prerequisite above passes. It has
ten working days and one purpose: determine whether a small, maintainable
`wasm-git` integration can remove full Git-database hydration for the named
workload and establish one transaction-aware publication boundary. It is not a
commitment to finish a production backend or general remote lifecycle.

### Days 1–2: reproduce demand and establish the control

- Pin and build wasm-git v0.0.17 at the audited commit.
- Generate the shared 1 GiB/100,000-object corpus and reproduce the partner's
  cold-open or competing-context failure.
- Record exact selected-variant bytes, bytes read during cold reopen, time to
  first bounded read, peak memory, ordinary commit, clone, and push on JSPI,
  Asyncify, and pthread/WASMFS when that deployment is applicable.
- Wrap stock wasm-git in a typed Worker RPC and a per-repository Web Lock.
- Prove two tabs serialize 100 intentionally overlapping control mutations.

### Days 3–5: prove the async ODB boundary and lazy reopen

- Add the smallest possible C export and JSPI/Asyncify bridge for a custom ODB.
- Implement read, read-header, exists, write, and streaming write against the
  current immutable facade or direct OPFS.
- Create and reopen canonical blob/tree/commit objects through libgit2.
- Reopen the large corpus without recursively hydrating its Git object database.
- Measure storage bytes read, bridge copies, latency, and memory on at least
  10,000 requested objects.

### Days 6–7: confront one pack and one publication boundary

- Implement a bounded `writepack`/quarantine path for one at least 64 MiB pack.
  Do not defer pack feasibility behind a loose-object demo.
- Implement snapshot-backed ref lookup plus a staged write/delete journal.
- Publish one branch and HEAD through the existing IndexedDB generation,
  revision, expected-ref, and receipt transaction.

### Days 8–9: bounded failure and concurrency evidence

- Run two independent browser contexts against the same origin and repository.
- Inject termination before object durability, after object durability, before
  metadata commit, after metadata commit, before response delivery, and after a
  worktree/index cache write but before metadata publication.
- Exercise reset/reinitialize ABA, reused idempotency keys, quota failure,
  corrupted object bytes, stale snapshots, and cache-generation mismatch.

### Day 10: compatibility, performance, and decision

- Clone one bounded pack, edit, add, commit, and reopen the bounded path. Fetch
  and push remain control regressions unless the backend seam already supports
  them without additional product scope.
- Export reachable objects and refs to canonical Git; verify exact OIDs and
  strict fsck.
- Compare option A and option B on the same hardware and browser build.
- Record patch size, upstream files touched, runtime size, memory, latency, and
  every failed criterion.
- End with one of three decisions: use stock wasm-git, use the Web Locks wrapper,
  or proceed with the custom backend.

## Quantitative go/no-go gates

All correctness gates are mandatory. A median success cannot compensate for
one invariant violation.

### Correctness

- The custom path completes init, one at least 64 MiB packed clone, add, commit,
  and reopen while the stock path remains the fetch/push regression control.
- The 1 GiB/100,000-object corpus reopens without recursively hydrating the Git
  object database into MEMFS.
- Canonical Git reproduces 100% of exported OIDs and
  `git fsck --full --strict` passes after clone, local commit, and reopen.
- 100 end-to-end two-context same-fence races plus 1,000 metadata-model races
  produce exactly one winner each, with no
  missing reachable object and no double revision advance.
- At least 20 end-to-end kill/restart schedules at each publication boundary
  plus 1,000 model-level fault schedules recover to exactly the pre-state or the
  fully committed post-state—never a third state.
- Every ambiguous post-commit retry returns the byte-for-byte-equivalent stored
  receipt without a new revision.
- 100 reset/reinitialize races reject every stale-generation mutation.
- Every stale worktree/index cache is detected and rebuilt before use; no test
  may infer authoritative refs from a dirty or mismatched cache.
- Injected quota and corruption failures publish zero invalid refs.

### Performance and resource bounds

- One selected production runtime, including new bridge/backend WASM, is no
  more than 2× the fastest applicable stock `wasm-git` variant in gzip bytes.
- On the large corpus, cold reopen reads no more than 5% of stored Git bytes,
  reaches the first requested object at least 2× faster than the fastest
  applicable stock variant, and uses no more than 256 MiB peak browser memory.
- Reopen and ordinary commit p95 are no more than 2× stock for the same corpus.
- Custom-backend peak resident browser memory during the 64 MiB pack case is no
  more than 1.25× the stock control. Any result above 2× is an immediate no-go.
- JavaScript bridge buffers for network and storage are individually capped at
  4 MiB during the custom path; no operation builds an unbounded JavaScript
  concatenation.
- Cancellation settles and releases its repository authority within 2 seconds
  in 100/100 injected cases.

### Maintainability

- Do not patch libgit2 internal source files. Use public or `git2/sys`
  version-pinned hooks plus wasm-git build/glue changes.
- Keep the production integration under 2,000 new non-test lines and touch no
  more than ten upstream wasm-git files during the spike.
- The stock option remains runnable as an unchanged control.
- Every backend contract and fault test runs from one documented command in a
  clean checkout.
- The `wasm-git` maintainer accepts the integration shape as plausibly
  upstreamable, or the design partner records a funded owner and upgrade policy
  for the fork. Silence is not evidence of maintainability.

### Decision rule

- **Proceed with custom ODB/refdb** only if every correctness gate passes, no
  performance no-go triggers, the named partner confirms the measured outcome
  matters, and the patch stays within the maintenance boundary.
- **Ship the Web Locks wrapper** if cooperative same-origin serialization meets
  the real requirement and custom storage does not add indispensable value.
- **Use stock wasm-git** if there is no demonstrated concurrent-writer or
  non-filesystem-storage requirement.

## Stop conditions

Stop the custom path immediately when any of these becomes true:

- the product cannot name a concrete mutation that requires atomic metadata
  beyond one cooperative Web Lock;
- ordinary OPFS is the only required backend and stock wasm-git meets recovery
  expectations;
- mapping libgit2's refdb lifecycle to one operation journal requires changes
  inside libgit2 rather than version-pinned backend hooks;
- clone/fetch cannot use the custom ODB without deferring or replacing
  `writepack`;
- one failed fault schedule can publish a ref to absent or corrupt bytes;
- the custom bridge exceeds the size, latency, memory, or patch-maintenance
  no-go thresholds;
- cross-context correctness depends only on timing, process memory, or a lock
  that stale code can bypass without a metadata fence;
- scope expands into reimplementing Git porcelain already supplied by libgit2;
  or
- the durable authority moves to a server, making the browser repository only
  a replaceable local cache.

## Why this complements wasm-git

wasm-git should continue to supply the Git engine, ordinary working-repository
behavior, pack parsing, and remote protocol implementation. The proposed work
adds a storage and publication contract at the points where browser
applications need stronger semantics.

The stock runtime remains:

- the functional fallback;
- the benchmark control;
- the fastest route when one cooperative writer is enough; and
- the upstream destination for generally useful loader, typed API, auth, and
  backend-hook improvements.

The custom path is successful only if it looks like a narrow wasm-git storage
extension with independently testable guarantees. If it begins to look like a
second Git implementation, it has already failed the strategy.

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
