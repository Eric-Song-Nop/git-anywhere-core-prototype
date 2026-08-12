# Deployment profile: BYOS and data-sovereignty Git

<!-- markdownlint-disable MD013 -->

> Status: conditional deployment profile of a transactional Git authority.
> “Bring your own storage” means that the
> authoritative Git immutable byte plane lives in storage controlled by the
> customer;
> it does not mean that every object-store API automatically has adequate Git
> semantics.

## Target users and job

The target users are:

- SaaS vendors that need embedded Git repositories but do not want to operate
  one persistent filesystem repository per tenant;
- regulated enterprises that require source data, encryption keys, residency,
  retention, and audit logs inside their own cloud account;
- platform teams that want a standard Git endpoint over S3-compatible, GCS,
  Azure, or other approved object storage plus an approved transactional
  database.

Their job is: **offer ordinary clone, fetch, and push while keeping durable Git
bytes and mutable repository authority in customer-selected services, without
making a local POSIX repository the durable source of truth**.

Before implementation, one named customer must identify the required storage
and metadata services, residency/key/retention constraints, expected repository
sizes and request rates, and the performance/cost premium it will accept. “We
may need several backends later” is not a demand signal.

Durable Objects can be one deployment profile: a per-repository Durable Object
could own transactional refs while R2 holds immutable packs. It is not the
thesis. The thesis is a capability-defined immutable byte plane plus a
transactional ref/manifest authority, deployable with Durable Objects,
PostgreSQL, Spanner-like databases, or another backend that satisfies the same
contract.

## Competitive baseline

The baseline includes more than wasm-git:

- stock Git provides mature Smart HTTP, atomic push when the server advertises
  it, quarantine, connectivity validation, hooks, packing, and maintenance on
  local repositories;
- GitLab's Gitaly provides repository RPC, replication, and operational
  tooling, but GitLab currently documents fast local storage as required and
  does not support NFS or cloud filesystems for repository data;
- JGit's internal DFS framework already models objects in packs on a storage
  system and is a serious JVM-side implementation baseline. It still requires
  concrete object/ref stores and a metadata catalog; it is not a drop-in
  object-store adapter;
- Git hosting services already provide data residency and managed operations
  in some plans;
- wasm-git is a capable local browser/Node Git runtime, but it is not a
  multi-tenant authoritative repository service.

Consequently, “OpenDAL-backed Git” is not sufficient differentiation. The
candidate must preserve standard Git behavior while materially reducing
persistent-disk operations or satisfying a buyer's storage-control requirement.

## Precise product promise

For an explicitly supported backend profile, the service provides:

- standard Git Smart HTTP clone, fetch, and push;
- immutable Git packs/objects stored in the customer's selected byte store;
- refs, HEAD, repository generation, pack manifest, leases/fences, and typed-API
  idempotency receipts stored in a transactional authority;
- ordinary receive-pack per-ref status: all refs reported successful publish in
  one metadata commit while rejected refs remain unchanged; when the client
  requests `git push --atomic`, every requested ref changes or none does;
- object quarantine and full connectivity validation before reachability;
- expected-old publication plus post-timeout ref inspection for ordinary Git;
  exact response replay only for a typed API request carrying a stable
  idempotency key, or an explicitly supported stable push option;
- no persistent authoritative repository directory on a service node; and
- documented backup, restore, GC, repack, quota, and key-rotation procedures.

Bounded local scratch space for receiving or generating a pack may be allowed
and measured. If every operation must hydrate the complete repository to that
scratch space, the central product claim has failed.

“Any OpenDAL backend” is not promised. Each backend must pass a capability and
conformance suite. Backends without reliable immutable create, bounded range
read, multipart completion semantics, or a compatible metadata authority may
be unsupported.

## Proposed architecture and data flow

```text
stock Git client
  │  Smart HTTP: protocol v2 upload-pack where supported;
  │  existing receive-pack push protocol
  ▼
stateless transport / policy layer
  │
  ├─ fetch: pin ref+pack manifest snapshot
  │          └─ stream existing immutable packs / generated delta pack
  │
  └─ push: receive into bounded quarantine
             ├─ parse and verify pack
             ├─ validate object connectivity and policy
             ├─ upload immutable pack/index/objects
             └─ publish accepted refs + pack manifest transactionally
                         │
                         ├─ metadata profile: PostgreSQL / equivalent
                         ├─ metadata profile: Durable Object storage
                         └─ local-development profile: SQLite

immutable byte profile: S3/R2/GCS/Azure/approved OpenDAL service
```

Every reader pins one metadata generation and resolves only packs from that
manifest. Writers never publish refs that name objects outside the accepted
manifest/quarantine result. GC marks from retained ref and reader snapshots,
waits through a documented grace period or lease horizon, and only then removes
unreferenced immutable generations.

Object-store conditional writes can protect an individual content-addressed
key. For example, S3 supports `If-None-Match` and `If-Match`, and S3 documents
strong read-after-write consistency and atomic single-key updates. Those facts
do not provide a multi-ref or ref-plus-manifest transaction. The metadata
authority remains mandatory.

Protocol v2 packfile/bundle URIs may offload immutable bytes to a CDN, but the
service must work without assuming every client supports experimental
capabilities.

### Retry and status semantics

Ordinary Git Smart HTTP supplies expected old OIDs and receives per-ref status,
but it does not supply a durable, universally stable idempotency key. After an
ambiguous push response, the stock client path converges by inspecting refs and
retrying from observed state; the server must never infer that a repeated body
is the same logical operation. Exact receipt replay belongs to the typed API or
to an opt-in push option whose stability and digest binding are documented.

For a normal multi-ref push, policy may accept a subset and reject the rest. The
metadata transaction publishes exactly the successful subset together with its
manifest; its response must match those per-ref statuses. For client-requested
`--atomic`, any rejection aborts the whole requested set. A deployment may
instead enforce all-or-none for every push as a stronger server policy, but it
must document that behavior rather than mislabel it as stock protocol semantics.

## Reuse and discard from the current prototype

### Reuse

- separation of immutable object bytes from mutable Git metadata;
- object-write and content-hash verification before ref publication;
- generation/revision/expected-ref fencing;
- atomic multi-ref/HEAD/config/shallow metadata mutation model;
- typed-API idempotency digest and exact receipt replay;
- structured backend errors and fault-cut testing;
- go-git custom Storer experience and canonical Git oracle.

### Discard or demote to test adapters

- the browser-only Go-WASM plus Rust-WASM topology as a universal service
  architecture;
- OPFS as the only immutable store;
- IndexedDB as the production server authority;
- one mutation-owning browser Worker as concurrency control;
- whole-object `Uint8Array` copies and loose-object-only storage;
- the fixed commit API and demo UI;
- SHA-1-only and bare-init-only product limits;
- the assumption that OpenDAL erases backend semantic differences.

The transaction contract is the main reusable asset. The current runtime is a
conformance fixture until it passes service-scale pack and protocol gates.

## Two-week vertical spike

First run the shared 2–3 day
[server-engine viability gate](09-validation-program.md#0-server-engine-viability-gate).
If bounded upload-pack/receive-pack, quarantine, and one atomic two-ref
publication seam do not pass, stop this deployment and use canonical Git or
JGit DFS. The remaining spike budget builds one narrow standard-Git service
profile:

1. Use MinIO/S3-compatible storage for immutable bytes and PostgreSQL for the
   metadata authority. A filesystem byte adapter plus SQLite may serve as a
   reference backend, not the product result.
2. Implement stock Git clone, fetch, and push over Smart HTTP for a bounded
   repository corpus.
3. Receive pushes into quarantine, verify connectivity, upload immutable
   pack/index bytes, then transactionally publish a pack manifest and every
   accepted ref. Rejected ordinary-push refs remain unchanged.
4. Exercise one ordinary two-ref push with per-ref status and one
   `git push --atomic`; advertise atomic capability only when all-or-none passes.
5. Start two writers from one old ref and require exactly one accepted
   non-force update.
6. Inject process termination before/after quarantine upload, immutable upload,
   metadata commit, and response. Restart with no warm memory or persistent
   repository directory. Reconcile an ambiguous stock push by reading refs;
   test exact receipt replay separately through the typed API.
7. Swap the byte adapter to a second implementation without changing Git or
   metadata semantics, then compare exact observable traces.
8. Run canonical Git clone/fetch/fsck after every accepted state.

Hooks, SSH, LFS, submodules, partial clone, CDN, multi-region replication, and
production GC are outside the two-week implementation. Their contracts and
explicit failure behavior must still be documented.

## Benchmark corpus and metrics

Use at least three deterministic repositories:

- small: 10 MiB, 1,000 objects, rapid ref-update workload;
- medium: 1 GiB, at least 100,000 objects, mixed text/binary and delta history;
- ref-heavy: at least 10,000 refs and an atomic multi-ref push fixture.

Use stock bare Git on local SSD only as the lower-bound/correctness oracle. The
performance controls are a same-region stock Git service and a same-region JGit
DFS service using the closest supportable storage profile. If a working JGit
comparison cannot be produced inside the viability gate, that is an unresolved
competitive risk, not permission to claim a performance win. Do not compare
only with `wasm-git`; that would be the wrong market baseline.

| Metric                     | Go threshold                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Git compatibility          | clone, fetch, push, atomic multi-ref push, and strict fsck pass with stock Git                                           |
| Authoritative disk state   | no persistent full repository directory; only bounded, removable quarantine/scratch                                      |
| Concurrent ref publication | 16 independent writers and at least 1,000 attempts with zero lost/torn updates                                           |
| Crash recovery             | every cut yields unreachable bytes or committed refs; stock Git converges by ref inspection; typed retry replays exactly |
| Backend portability        | second byte adapter produces the same refs/OIDs/typed-receipt trace with configuration-only selection                    |
| Relative performance       | for each matching operation, candidate p95 / fastest same-region service-control p95 <= 2.0                              |
| Absolute read SLO          | warm no-op fetch p95 <= 500 ms and 1 GiB full-clone payload throughput >= 50 MiB/s                                       |
| Absolute write SLO         | accepted <=1 MiB push p95 <= 3 s, measured from request start through final receive-pack status                          |
| Storage accounting         | every reachable manifest byte is attributable; orphan quarantine/generation bytes are discoverable                       |

Do not subtract storage or network time from these ratios; report it by class.
Also report object-store requests, bytes, range efficiency, temporary disk,
peak memory, pack-generation CPU, transaction duration, retry counts, orphan
bytes, and estimated storage/API cost. Data-sovereignty buyers may accept a
performance premium, but that exception requires an identified design partner
and a recorded threshold; it cannot be assumed.

## Failure, security, and operational risks

- **Git server correctness is broader than ref CAS.** Receive-pack quarantine,
  connectivity, fast-forward policy, signed pushes, hooks, alternates,
  shallow state, and atomic capability advertisement all matter.
- **JGit DFS is an existing implementation path.** A new engine must beat it
  on runtime fit, backend portability, operations, or measured economics.
- **Backend semantics leak.** Multipart completion, conditional writes, range
  behavior, list consistency, checksums, versioning, and error retryability vary.
- **Object storage is not a transaction database.** Never publish mutable refs
  by overwriting several object keys and calling the sequence atomic.
- **GC is a distributed safety problem.** Stale readers, delayed writers,
  retained snapshots, forks, and failed transactions can all retain objects.
- **Pack processing is an attack surface.** Enforce limits on input bytes,
  delta depth, object count, decompression, CPU, memory, refs, path length, and
  quarantine lifetime.
- **Tenant and credential isolation are mandatory.** Use per-tenant scopes,
  short-lived credentials, encryption boundaries, audited access, and no
  cross-tenant existence oracle.
- **Hooks may require a sandbox.** Do not run arbitrary repository hooks in the
  transport process or promise hook parity before an isolation design exists.
- **Split-plane backup must be consistent.** A database backup and object-store
  backup taken independently may not describe the same generation; publish and
  retain restorable snapshot manifests.
- **Cost can dominate.** Small-object request volume, list operations, egress,
  and repack read amplification may exceed local SSD economics.
- **Durable Object limits are profile-specific.** Eviction, storage limits,
  CPU/runtime constraints, and pricing must be tested if that profile is used;
  they must not shape the portable storage contract.

## Go/no-go and stop conditions

Proceed only if the named customer confirms the result, stock Git
interoperability, atomic publication, process-restart recovery, and two byte
adapters all pass. A single MinIO happy path is not enough to claim BYOS.

Stop or replace the implementation if:

- accepted pushes can expose refs before full connectivity is proven;
- standard Git clone/fetch/push requires a custom client;
- atomic pushes are advertised but can partially update refs;
- each operation hydrates a complete persistent repository;
- backend-specific branches dominate the Git/storage core and a capability
  contract cannot contain them;
- no second byte adapter passes the same semantic trace;
- p95 latency or request cost exceeds the recorded buyer threshold without a
  data-sovereignty design partner;
- a JGit DFS or stock-Git-with-ephemeral-cache implementation meets the same
  job more simply;
- no customer requires customer-owned storage strongly enough to accept the
  additional operational complexity.

## Primary sources

- [Git HTTP protocol](https://git-scm.com/docs/http-protocol)
- [Git protocol v2](https://git-scm.com/docs/protocol-v2.html)
- [Git receive-pack quarantine and connectivity](https://git-scm.com/docs/git-receive-pack.html)
- [Git push atomicity and its single-remote boundary](https://git-scm.com/docs/git-push.html)
- [Git packfile URIs](https://git-scm.com/docs/packfile-uri.html)
- [GitLab Gitaly architecture and local-storage requirements](https://docs.gitlab.com/administration/gitaly/)
- [JGit 7.7.1 DFS implementation package](https://github.com/eclipse-jgit/jgit/tree/v7.7.1.202607240634-r/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/dfs)
- [Amazon S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)
- [Amazon S3 conditional writes](https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html)
- [Cloudflare Durable Objects storage transactions](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Apache OpenDAL documentation](https://opendal.apache.org/docs/rust/opendal/)

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
