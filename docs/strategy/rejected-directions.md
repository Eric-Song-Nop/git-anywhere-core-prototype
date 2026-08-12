# Rejected directions

<!-- markdownlint-disable MD013 -->

Status: default `STOP` decisions. Reopen only on the concrete evidence listed
for each direction.

## Why this list exists

The current prototype proved a narrow storage contract. That proof does not
make every adjacent Git idea a product opportunity. The directions below
either duplicate a stronger implementation, expose no user-visible advantage,
or require a different product whose hard work lies outside this repository.

The default decision is to adopt the incumbent and preserve only reusable
tests. "We have already built part of it" is not a reopening condition.

| Direction                    | Decision                    | Existing answer                                             |
| ---------------------------- | --------------------------- | ----------------------------------------------------------- |
| Ordinary browser Git client  | Stop; adopt/pin `wasm-git`  | libgit2 in WASM with OPFS, clone, worktree, fetch, and push |
| OpenDAL-only storage swap    | Stop as a product           | Platform-native APIs or OpenDAL as an implementation detail |
| Generic local-first/E2EE Git | Stop                        | `wasm-git`, normal remotes, existing encryption add-ons     |
| Git-as-database/CMS          | Stop without a vertical app | Domain database/CRDT plus export, or existing Git engines   |
| Simple S3 backup             | Stop                        | `git bundle` and forge-native object-storage backup         |
| P2P Git                      | Stop                        | Radicle and other Git-native P2P systems                    |
| Data-lake versioning         | Stop                        | lakeFS and formats designed for object-store datasets       |
| Generic artifact registry    | Stop                        | OCI Distribution/Artifacts plus signing standards           |
| Compliance/audit ledger      | Stop                        | WORM retention, signatures, and transparency logs           |

## 1. Another ordinary browser Git client

### Why the browser-client direction is rejected

Do not continue the current Go-WASM runtime toward clone, checkout, status,
merge, fetch, push, stash, tags, reflogs, GC, and general Git porcelain.

Current [`wasm-git`](https://github.com/petersalomonsen/wasm-git) already
compiles libgit2 to WebAssembly, publishes Node and browser builds, supports
several persistent OPFS variants, and demonstrates real clone/edit/commit/push
workflows. Its current package ships individual WASM variants around 0.86-1.63
MB raw. The current prototype's Go module is 11,025,421 bytes raw while its
documented scope is SHA-1, bare-only, a fixed proof commit, and no network or
pack lifecycle.

Closing that feature gap would duplicate mature libgit2 behavior while adding
bundle size and a two-language storage bridge. Transactional metadata is not
enough to make an incomplete Git client preferable.

### Browser-client alternative

Pin and vendor a reviewed `wasm-git` release. Add a typed wrapper, auth,
progress, cancellation, and application-specific UX. If crash-safe storage is
a hard requirement, attempt the narrow storage/backend integration described
in [transactional storage for wasm-git](01-transactional-wasm-git-storage.md).
Fork only that boundary, not the Git command surface.

### Browser-client reopening gate

A required, measured workload cannot be implemented in libgit2/`wasm-git`, a
minimal upstream extension is impossible, and the gap is important enough to
fund long-term Git compatibility. Smaller bundle size or a different language
alone is not sufficient.

## 2. "OpenDAL for Git" or an OpenDAL-only storage swap

### Why the OpenDAL-only direction is rejected

Replacing OPFS, S3, R2, or another byte store with an
[`OpenDAL`](https://opendal.apache.org/) operator changes plumbing, not the
user's job. It does not add clone/push compatibility, atomic refs, pack
negotiation, lower latency, data sovereignty, recovery evidence, or a buyer.

The current OpenDAL module stores immutable object envelopes in browser OPFS.
For a single platform, a direct binding is smaller and exposes platform-native
conditions, ranges, streams, errors, and observability more clearly. For a
browser, OpenDAL also does not make OPFS ref updates atomic.

### OpenDAL alternative

Use OpenDAL only after a product direction proves that several storage
providers are a requirement and its lowest common denominator preserves the
needed semantics. The [BYOS direction](04-byos-data-sovereignty-git.md) is one
possible place; even there, provider certification and Smart HTTP behavior are
the product, not the adapter library.

### OpenDAL reopening gate

A named customer requires at least two object-store providers in the first
deployment, provider switching works without data hydration, and a vertical
spike passes the same correctness and performance gates through both.

## 3. Generic local-first Git or end-to-end encryption

### Why the local-first/E2EE direction is rejected

Do not position local persistence, offline commits, or user-controlled sync as
new. `wasm-git` explicitly targets local-first web applications and persists
repositories through IDBFS or OPFS. Normal Git already syncs immutable history
to multiple remotes.

Encryption is also an adjacent layer rather than a reason for this core.
[`encrypted-git-storage`](https://github.com/petersalomonsen/encrypted-git-storage)
already demonstrates encrypted storage alongside `wasm-git` and a native Git
remote helper. A credible E2EE product must solve identity, device enrollment,
key sharing and rotation, revocation, recovery, metadata leakage, quota, and
conflict UX. None of those comes from an IndexedDB ref transaction.

### Local-first/E2EE alternative

For an application that wants local history, use `wasm-git` or a simpler
domain store and add a standard, reviewed encryption scheme at the sync
boundary. Validate the application threat model independently from storage
crash safety.

### Local-first/E2EE reopening gate

A specific vertical application proves that existing local-first engines
cannot meet its sync/recovery workflow and that customers value a new key and
conflict model. A generic "your data stays yours" message is not evidence.

## 4. Generic Git-as-database or Git-backed CMS

### Why the Git-as-database direction is rejected

Git supplies immutable history, branching, and merge. It does not supply an
application query model, schema evolution, record-level authorization,
subscriptions, efficient partial updates, rich conflict semantics, quota, or
index maintenance. Modeling every application mutation as a tree rewrite can
also turn many-small-record workloads into excessive object and history
overhead.

`wasm-git` already lets a web application hide Git behind a synchronization
button. The current prototype adds no vertical schema, editor, publishing
workflow, or collaboration UX that would distinguish a CMS.

### Git-as-database alternative

Choose a database or CRDT appropriate to the application. Export snapshots or
history to Git when interoperability and user ownership matter. If the data is
naturally a small set of text files and Git history itself is the user-facing
model, use an existing Git engine.

### Git-as-database reopening gate

One vertical application supplies a dominant workload, conflict policy, and
buyer; Git object history measurably beats the database/CRDT baseline; and a
real integration passes the two-week test. Do not reopen for a generic SDK.

## 5. Simple S3 backup or archive

### Why simple S3 backup is rejected

Uploading repository bundles to an object store is established practice.
[`git bundle`](https://git-scm.com/docs/git-bundle) creates files that stock Git
can clone or fetch. GitLab's Gitaly can create repository bundles and
[stream server-side backups directly to object storage](https://docs.gitlab.com/administration/backup_restore/backup_archive_process/),
including incremental backup workflows.

A periodic mirror or bundle upload does not need this prototype's split
backend. It also does not by itself prove RPO, preserve force-pushed/deleted
tips, restore to another provider, detect silent corruption, or continuously
exercise disaster recovery.

### Simple-backup alternative

Use forge-native backup or stock bundles for a single provider. The only
potentially differentiated option is the separately scoped
[verified cross-provider backup](03-verified-cross-provider-backup.md), where
continuous restore evidence and provider independence—not S3—are the product.

### Simple-backup reopening gate

A buyer requires multiple forge connectors, immutable ref timelines, and
measured cross-provider restore RPO/RTO that incumbent backup cannot provide.
"Store Git in our bucket" is not enough.

## 6. Peer-to-peer Git

### Why the P2P direction is rejected

P2P is a network and collaboration product, not an object-backend feature. It
must solve peer identity, discovery, NAT traversal or relay, authorization,
availability when peers are offline, replication policy, abuse, ref
divergence, and user-facing conflict handling.

[`Radicle`](https://radicle.xyz/2024/09/10/radicle-1.0.0.html) is already a
peer-to-peer, local-first collaboration stack built on Git. The current
prototype's single-origin IndexedDB CAS does not provide a distributed ref
protocol or a reason to compete with that ecosystem.

### P2P alternative

If a browser application needs device-to-device transfer, keep `wasm-git` as
the local engine and spike the smallest WebRTC/relay transport against its
actual offline and identity requirements. Do not rewrite Git storage first.

### P2P reopening gate

A named application requires browser-to-browser or LAN operation that existing
Git remotes and P2P systems cannot provide, and the team has a credible
identity, relay, replication, and conflict design. Transport novelty alone is
not a moat.

## 7. Data-lake versioning

### Why the data-lake direction is rejected

Large analytic datasets have different objects, access patterns, and merge
semantics from source code. They need zero-copy branches over existing object
store keys, table/catalog integration, large-object metadata, partition-aware
operations, retention, and data-engine interoperability.

[`lakeFS`](https://docs.lakefs.io/v1.66/understand/model/) already manages
object-store data through repository/commit/branch concepts and implements
zero-copy branching by moving pointers rather than copying the underlying
data. Re-encoding a data lake as Git blobs and trees adds hashing, pack, and
GC costs while losing domain integration.

### Data-lake alternative

Use lakeFS or the versioning model native to the table/catalog format. Git may
version schemas, queries, or small manifests that point to data; it should not
become the generic data plane.

### Data-lake reopening gate

The workload consists primarily of Git-compatible small objects, must round
trip through ordinary Git clients, and beats lakeFS or native table versioning
on a representative dataset. At that point it is no longer a generic data
lake claim.

## 8. Generic binary or model artifact registry

### Why the artifact-registry direction is rejected

An artifact registry needs resumable/chunked transfer, content discovery,
media types, manifests, deduplication, retention, vulnerability/provenance
metadata, signatures, and ecosystem clients. Git's source-history graph and
delta packs are not a better default for large immutable build/model outputs.

The [OCI Distribution Specification](https://specs.opencontainers.org/distribution-spec/)
already standardizes content-agnostic blob and manifest push/pull, resumable
transfer, discovery, and deduplication. [OCI artifacts](https://oras.land/docs/1.1/concepts/artifact/)
cover content beyond container images. [Sigstore](https://docs.sigstore.dev/)
adds identity-bound signatures and a transparency log.

### Artifact-registry alternative

Publish the artifact as OCI or use an established package/model registry. Git
can carry source pointers, lockfiles, or small metadata. If an artifact must be
co-versioned with source, put its digest in Git rather than its entire payload.

### Artifact-registry reopening gate

Ordinary Git compatibility is a buyer requirement, the artifacts are sized
and changed like source files, and a benchmark beats OCI pull/push and cache
behavior. A content-addressed byte store by itself is not a registry.

## 9. Compliance, tamper-proof audit, or WORM ledger

### Why the audit-ledger direction is rejected

The current prototype is not a tamper-proof archive. It uses SHA-1 Git object
IDs, mutable refs, one local metadata authority, and no signed checkpoints,
independent witness, retention lock, legal hold, access evidence, trusted time,
or key-rotation policy. Crash consistency proves that a write is old or new;
it does not prove who authorized it or that an administrator cannot rewrite
the whole store.

Real audit systems combine immutable retention with signatures and independent
verification. Sigstore's
[`Rekor`](https://docs.sigstore.dev/logging/overview/) is an example of an
append-only transparency log whose entries and tree state can be
cryptographically verified. Cloud/object-store WORM and legal-hold controls
solve a different part of the requirement.

### Audit-ledger alternative

For source archives, use canonical Git/bundles plus provider object lock,
signed release evidence, monitored transparency, documented retention, and
periodic independent restore. Keep the Git storage engine out of the trust
root when possible.

### Audit-ledger reopening gate

A regulated buyer provides an explicit threat model, retention and legal-hold
policy, acceptable hash/signature suite, witness model, and audit standard.
That would be a new compliance product; it should not inherit the current
SHA-1/browser architecture by default.

## Final rule

Reject a direction when its shortest description is a technology substitution
(`OpenDAL`, `WASM`, `OPFS`, `R2`, `P2P`) rather than a measured user outcome.
Reopen it only with a named user, an incumbent baseline, a two-week vertical
experiment, and predeclared kill gates. Otherwise adopt the incumbent, keep the
conformance evidence, and stop.

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
