# Product hypothesis: verified cross-provider Git backup and recovery

<!-- markdownlint-disable MD013 -->

> Status: product hypothesis. The initial scope is Git repository state only.
> Issues, pull requests, permissions, CI data, packages, releases, LFS, wikis,
> and provider-specific metadata are excluded unless separately named and
> tested. Calling the spike a complete SaaS backup would be misleading.

## Target users and job

The primary users are platform, security, and IT teams that operate repositories
across GitHub, GitLab, self-hosted Git, or multiple organizations. Their job is
to:

- maintain an independent history of objects and refs;
- recover a deleted repository or a branch lost to force-push;
- prove that a backup can actually be restored;
- migrate Git history to a different provider without relying on a
  provider-specific archive format; and
- retain immutable recovery points under an explicit retention policy.

The buyer is not paying for another scheduled `git clone --mirror`. The product
promise must be continuous, verifiable, incremental, and cross-provider.

Before implementation, one named buyer must state that Git history alone is a
valuable recoverable unit, name source and restore providers, and predeclare its
required recovery point objective (RPO), recovery time objective (RTO),
retention, and maximum storage/API cost. If issues, pull requests, permissions,
LFS payloads, or other forge metadata are mandatory for the buying decision,
this Git-only spike is not evidence for the requested product.

## Competitive baseline

Stock Git mirror clones and bundles are valid, simple baselines. GitHub
documents mirror clone as a repository backup and migration archives for some
additional metadata, while warning that migration archives omit data and have
no documented restore path back to GitHub. GitLab has mature instance and
server-side repository backup workflows: Gitaly can upload refs, bundles,
custom hooks, and manifests to object storage, and GitLab supports incremental
repository backups.

Commercial products are also direct incumbents, not future comparisons.
[Rewind Backups for GitHub](https://rewind.com/products/backups/github/) provides
scheduled GitHub repository and metadata backup, retention, restore, and
customer-cloud copies. [GitProtect](https://gitprotect.io/gitlab.html) advertises
repository plus metadata protection and cross-provider recovery. The spike must
record their supported scope, published RPO/RTO or measured trial behavior,
restore destinations, and price for the design-partner workload. A Git-only
candidate must offer a material portability, verification, RPO/RTO, or cost
advantage rather than comparing only with a shell script.

The strategy must not misrepresent those systems as absent. Potentially useful
gaps are:

- one repository-history format across providers;
- ref history that preserves force-pushed and deleted tips;
- content-addressed deduplication across independent snapshots;
- continuously exercised restore, rather than backup-job success alone; and
- restoring Git history to a different provider or standard bare remote.

Assumption: some organizations will buy Git-only resilience independently of
issue/PR/permission backup. This must be validated. Many enterprise buyers will
instead require a full provider backup, which would expand the product far
beyond this repository.

## Precise product promise

For each protected repository, the service records a sequence of immutable,
self-describing recovery snapshots. Each published snapshot identifies:

- source provider/repository identity and observation time;
- object format and exact refs, including deleted-ref tombstones relative to
  the previous snapshot;
- the immutable packs or objects required to restore all advertised refs;
- integrity digests, ingestion version, and verification result;
- retention class and optional WORM/object-lock metadata.

A snapshot becomes visible only after all referenced Git bytes have been
uploaded and verified. Restoring any retained snapshot must not depend on an
intermediate snapshot manifest still existing. The service regularly restores
sampled or policy-required snapshots into an isolated bare repository, runs
canonical Git validation, and records the evidence.

The promise is Git object/ref recovery. It is not initially a promise to restore
GitHub or GitLab collaboration metadata.

## Proposed architecture and data flow

```text
source Git endpoint
  │  ls-refs + incremental fetch / mirror fetch
  ▼
bounded pack quarantine
  │  parse, hash, connectivity and format validation
  ▼
immutable byte plane
  │  packs/indexes or objects keyed by algorithm + digest
  ▼
snapshot builder
  │  exact refs + required pack/object inventory + tombstones
  ▼
transactional snapshot authority
  │  expected previous generation + receipt => publish snapshot
  ▼
restore verifier ──► isolated bare repo or destination Git endpoint
                       └─ strict fsck + exact ref comparison
```

The immutable byte plane should prefer pack-aware storage. Exploding every pack into
loose objects may improve cross-repository dedup but can multiply request cost;
keeping every source pack avoids parsing cost but weakens dedup and independent
snapshot composition. The spike must measure both strategies on the same
corpus rather than decide by intuition.

Ref snapshots belong in a transactional database. Object storage versioning or
conditional writes can protect individual manifest objects, but they do not
replace multi-record publication, retention, job ownership, and receipt
semantics.

## Reuse and discard from the current prototype

### Reuse

- content-address verification of Git object bytes;
- immutable bytes published before reachable metadata;
- required-object preflight;
- generation/revision and expected-state CAS;
- idempotency receipts for ambiguous completion;
- deterministic fault cuts and restart coverage;
- independent canonical Git OID and strict-fsck oracle.

### Discard or replace

- browser UI, dedicated Worker, and OPFS as product runtime assumptions;
- IndexedDB as the service metadata authority;
- the fixed three-object repository;
- loose whole-object envelopes as the only backup representation;
- one-repository reset semantics;
- “reachable from current HEAD” as a sufficient inventory rule;
- SHA-1-only repository identity.

The current prototype's transaction semantics are useful. Its storage volume,
pack, retention, provider, and security behavior are not yet evidence for a
backup product.

## Two-week vertical spike

Start only after the named-buyer gate passes. Build a Git-only recovery slice
with no provider metadata:

1. Generate at least 50 deterministic repositories with branches, tags,
   annotated tags, merges, renames, empty repositories, and one SHA-256 fixture
   if the chosen libraries support it.
2. Serve half from a GitHub-compatible Smart HTTP endpoint and half from a
   GitLab/self-hosted-compatible endpoint. Include two public read-only
   repositories as non-generated sanity cases.
3. Ingest an initial snapshot, then add commits, delete refs, rewrite branch
   history, and ingest a second and third snapshot.
4. Kill the ingester at every boundary between pack receipt, verification,
   immutable upload, manifest write, and metadata publication.
5. Remove source repositories and one intermediate snapshot manifest.
6. Restore every retained first and third snapshot into a clean standard bare
   endpoint, compare exact refs, and run strict fsck.
7. Record both pack-preserving and object-deduplicating storage costs for the
   same input.

Provider OAuth, issues, PRs, LFS, and UI are deliberately outside the spike.
The result must say “Git repository recovery spike,” not “GitHub backup.”

## Benchmark corpus and metrics

The corpus must include:

- at least 50 repositories and 10,000 total reachable objects;
- forks or duplicated histories to measure safe dedup potential;
- force-pushed and deleted refs;
- at least one repository with a pack larger than 1 GiB or a documented local
  substitute if the two-week environment cannot afford that fixture;
- signed and annotated tags, shallow-source rejection, malformed pack inputs,
  and Git LFS pointer files even though LFS payload backup is out of scope.

| Metric                         | Go threshold                                                                                                                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published snapshot correctness | 100% exact advertised refs and required object connectivity                                                                                                                                     |
| Restore validation             | every retained snapshot restores and passes `git fsck --full --strict`                                                                                                                          |
| Force-push recovery            | every superseded protected tip remains restorable until retention expiry                                                                                                                        |
| Incremental storage            | report logical unique-object bytes and actual physical stored bytes separately; use the corpus-specific 10% metadata/index target only after fixing pack and delta policy                       |
| Incremental economics          | across the three spike snapshots, physical stored bytes <=70% of the selected repeated-mirror/bundle incumbent and projected storage plus API cost stays within the buyer's predeclared ceiling |
| Crash behavior                 | no snapshot is visible with a missing required pack/object; retry is exact                                                                                                                      |
| Manifest independence          | deleting an unretained intermediate manifest does not break a retained later restore                                                                                                            |
| Cross-provider path            | at least one source-to-different-destination restore succeeds with stock Git                                                                                                                    |
| Evidence                       | restore receipt includes source snapshot, exact refs, tool versions, and verification output digest                                                                                             |
| Spike RPO                      | a protected ref change is present in a verified snapshot within 15 minutes                                                                                                                      |
| Spike RTO                      | a 1 GiB retained snapshot becomes cloneable and strictly verified within 30 minutes                                                                                                             |
| Buyer fit                      | the named buyer accepts Git-only scope and confirms the result beats its selected incumbent                                                                                                     |

Also report source bytes read, object-store requests, packed and unpacked sizes,
dedup ratio by and across tenants, snapshot latency, restore throughput, memory,
and rate-limit behavior. A claimed dedup saving must exclude data that policy
forbids sharing across tenant trust boundaries.

## Failure, security, and operational risks

- **A Git-only backup may be commercially incomplete.** Issues, PRs, comments,
  permissions, releases, packages, LFS, and secrets often matter more than Git
  objects during disaster recovery.
- **Provider APIs and rate limits change.** Prefer standard Git transport for
  repository history and isolate provider-specific metadata connectors.
- **Incremental chains can be fragile.** Each retained manifest must enumerate
  enough immutable inventory to restore independently, even if bytes are
  deduplicated globally.
- **Malicious packs are untrusted input.** Bound pack size, delta depth,
  decompression, CPU, object count, tree width, path length, and parser memory.
- **Cross-tenant dedup leaks existence.** Never expose timing, error, billing,
  or OID-presence signals across authorization boundaries. Tenant-scoped
  encryption may intentionally sacrifice global dedup.
- **Credentials are high value.** Use provider apps or narrowly scoped,
  short-lived read credentials; never persist credentials in snapshot data.
- **Retention and deletion can conflict.** WORM/object-lock policies must be
  reconciled with contractual deletion and privacy requirements before launch.
- **SHA-1 is not a modern integrity boundary.** Preserve Git compatibility but
  add algorithm-tagged keys, independent strong digests, and collision-aware
  validation.
- **Backups that are never restored are unproven.** Scheduled restore evidence
  and alerting are part of the product, not optional operations.
- **Forks, alternates, submodules, and LFS have separate reachability.** They
  must be rejected or represented explicitly; ordinary Git fsck does not prove
  external payload recovery.

## Go/no-go and stop conditions

Proceed only if the spike proves independent, exact cross-provider recovery,
the predeclared RPO/RTO, physical bytes no greater than 70% of the selected
repeated-mirror/bundle incumbent across the three snapshots, and projected
storage plus API cost within the buyer's predeclared ceiling. The named buyer
must confirm a material advantage over its selected forge-native or commercial
incumbent; internal restore success is not market evidence.

Stop or narrow the direction if:

- the implementation is only a scheduled mirror clone or bundle uploader;
- later restore depends on every intermediate backup artifact remaining intact;
- a provider-neutral restore cannot be completed with stock Git;
- every snapshot rereads or rewrites most unchanged repository bytes;
- expected customers require full collaboration metadata and no funded path
  exists to add it;
- Rewind, GitProtect, or the buyer's existing backup meets the same RPO, RTO,
  restore-destination, verification, and cost requirements;
- credential/rate-limit requirements make continuous coverage impractical;
- restore verification cannot be isolated and safely automated;
- the only differentiated claim is global dedup but tenant isolation removes
  most of the saving.

## Primary sources

- [GitHub: Backing up a repository](https://docs.github.com/en/repositories/archiving-a-github-repository/backing-up-a-repository)
- [GitHub: Restoring a deleted repository](https://docs.github.com/en/repositories/creating-and-managing-repositories/restoring-a-deleted-repository)
- [GitLab: Back up GitLab](https://docs.gitlab.com/administration/backup_restore/backup_gitlab/)
- [GitLab: Backup archive process](https://docs.gitlab.com/administration/backup_restore/backup_archive_process/)
- [GitLab: Restore GitLab](https://docs.gitlab.com/administration/backup_restore/restore_gitlab/)
- [Rewind Backups for GitHub](https://rewind.com/products/backups/github/)
- [GitProtect GitLab backup and recovery](https://gitprotect.io/gitlab.html)
- [Git clone mirror semantics](https://git-scm.com/docs/git-clone.html)
- [Git receive-pack quarantine and connectivity checks](https://git-scm.com/docs/git-receive-pack.html)
- [Git repack format and purpose](https://git-scm.com/docs/git-repack)

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
