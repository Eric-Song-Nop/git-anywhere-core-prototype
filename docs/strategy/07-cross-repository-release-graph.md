# Adjacent product: pinned multi-repository release manifest

<!-- markdownlint-disable MD013 -->

Status: adjacent orchestration product hypothesis; no implementation without a
named design partner who accepts manifest-mediated reads.

## Decision

This direction is defensible only when a platform team must consume a set of
repository revisions as one release. The atomic object is a release manifest,
not the refs hosted by several independent Git servers.

No service can make unrelated GitHub, GitLab, Bitbucket, or self-hosted
repositories change atomically without their cooperation. A coordinator can
prepare immutable commits in each repository and atomically publish one
manifest that names them. Consumers get all-old or all-new behavior only when
they resolve through that manifest.

If consumers insist on reading ordinary branch heads directly from the
external hosts, stop: the promised cross-repository atomicity is impossible.

## User and job

The user is a platform, GitOps, release engineering, or regulated deployment
team whose release spans application source, infrastructure, policy, and
configuration repositories.

Their job is:

> Promote, audit, consume, and roll back one exact set of repository revisions
> without any reader observing a half-promoted release.

The user-visible result is a stable release identifier resolving to immutable
Git commit OIDs across all repositories. “Manifest” is deliberate: this does
not claim an atomic graph mutation at independent Git hosts, and it is not a
faster local Git client.

## Why wasm-git alone does not solve it

`wasm-git` operates one local repository at a time and synchronizes it with
ordinary remotes. Git's own atomic-push guarantee is scoped to refs on one
remote. The current [`git-push` documentation](https://git-scm.com/docs/git-push)
explicitly says group pushes are not atomic: failures are reported per remote
and the command continues to the remaining remotes.

A browser can run ten excellent `wasm-git` instances and still observe nine
successful pushes followed by one rejection. Cross-repository publication
requires a coordination protocol above Git.

## Honest consistency boundary

Suppose release `R42` should contain:

```json
{
  "application": "https://forge-a.example/acme/app.git@<commit-a>",
  "policy": "https://forge-b.example/acme/policy.git@<commit-b>",
  "infrastructure": "https://forge-c.example/acme/infra.git@<commit-c>"
}
```

The coordinator can guarantee that a lookup of the current release returns
either the complete previous manifest or complete `R42`. It cannot guarantee
that the mutable `main` branches at all three forges move in the same instant.
Those branch updates are asynchronous conveniences and may visibly disagree.

This limitation must appear in the API, documentation, UI, and service-level
objectives. Calling sequential remote pushes a transaction would be a false
claim.

## Proposed architecture

```text
release producer
      |
      | expected release generation + repository commit set
      v
coordinator / policy engine
      |
      +-- verify commit existence, reachability, signatures, policy
      +-- ensure every commit has a durable reachability anchor
      +-- write immutable manifest by digest
      |
      v
transactional release authority
  - current generation pointer
  - immutable manifest digest
  - expected-old CAS
  - idempotency receipt
  - audit metadata
      |
      v
resolver / GitOps integration
  resolve once -> fetch exact OIDs -> verify manifest -> deploy
```

### Prepare

1. The producer supplies a complete manifest and the expected current release
   generation.
2. The coordinator verifies each commit, repository identity, authorization,
   required status, and signature policy.
3. Each commit receives a durable reachability anchor before publication. That
   may be a permanent release tag/ref controlled by the service, or an
   immutable bundle/mirror. Merely knowing an unadvertised OID is insufficient:
   an external host may refuse to fetch it and later garbage-collect it.
4. The coordinator writes the canonical manifest under its digest and reads it
   back. The manifest includes repository identity, commit OID, object format,
   reachability anchor, and policy evidence.

### Publish

One small metadata transaction compares the expected release generation,
advances the current pointer to the immutable manifest, and records the
request digest and result. A crash before this commit leaves an unused prepared
manifest; a crash after it but before the response is resolved by retrying the
same idempotency key.

### Read and roll back

A reader resolves the release once and pins the returned manifest digest for
the whole operation. It fetches exact commits or bundles and verifies the
object IDs before use. It must not re-resolve `current` independently for each
repository.

Rollback is another atomic pointer publication to a previously admitted
manifest. It does not rewind external branch heads atomically.

### Relationship to standard Git

The manifest resembles the pinning provided by
[`gitlinks` and submodules](https://git-scm.com/book/en/v2/Git-Tools-Submodules),
but need not force a superproject layout. A submodule superproject is the first
baseline: it may already solve the job with much less infrastructure.

Stock Git must remain able to fetch and strictly verify every named commit.
The resolver may produce a checkout plan or a bundle list, but it must not
silently translate mutable branch names into different commits for different
readers.

## Reuse and throwaway

| Reuse                                  | Adapt                                                             | Throw away                             |
| -------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| Generation/revision expected-state CAS | `MetadataMutation` into a release-manifest transaction            | Go-WASM Git command engine             |
| Multi-field atomic publication         | Required-object fence into required-commit/anchor verification    | Rust OpenDAL OPFS module               |
| Request digest and exact receipt       | Fault cuts into cross-service preparation and pointer publication | IndexedDB and browser Worker ownership |
| Old-or-new reader oracle               | Git object oracle into a multi-repository checkout verifier       | Demo UI and fixed proof repository     |

Almost all new work is product and integration work: forge connectors,
release policy, durable anchors, signatures, resolver integration,
authorization, and audit. The current storage implementation is not a moat.

## Competitive and standards baseline

Compare against the simplest mechanisms that already pin immutable versions:

1. A Git superproject with submodule gitlinks.
2. A signed JSON/YAML lockfile stored in ordinary Git or an object store.
3. The target GitOps/deployment system's existing release or multi-source
   manifest.
4. One monorepo and one native atomic push, when organizational constraints
   permit consolidation.

Git's `--atomic` option is a relevant single-remote primitive, not a
cross-remote solution. If all repositories are actually namespaces in one
authority under one transaction, this becomes a simpler server feature and no
longer needs the external-host claim.

A high-assurance version also needs signing and a trust policy. Git OIDs alone
prove content identity, not who authorized the release. Existing systems such
as [Sigstore](https://docs.sigstore.dev/) already combine identity, signatures,
and transparency; do not invent a weaker bespoke trust story.

## Two-week spike

Use ten repositories split across at least two independently administered Git
HTTP endpoints. Give each repository three release-relevant refs and generate
conflicting updates, deleted branches, and force-pushes.

### Build only

- a canonical manifest format with repository identity and exact commit OIDs;
- a prepare operation that verifies and anchors every commit;
- one compare-and-publish current-release pointer with an exact retry receipt;
- a resolver that pins a manifest once and produces a checkout plan;
- a rollback operation that republishes a prior admitted manifest;
- a stock-Git verifier for the resulting checkout.

Do not build a general forge UI, deployment controller, merge engine, or
cross-provider branch synchronizer.

### Exercise

- Publish a ten-repository release while 100 readers continually resolve and
  fetch it.
- Kill the coordinator before and after each repository verification, anchor,
  manifest write, metadata commit, and response.
- Make one required commit missing or unfetchable; publication must reject.
- Race two producers using the same expected release generation; exactly one
  wins.
- Retry a successful request after response loss; the release generation must
  not advance again.
- Mutate external branch heads during and after publication; pinned readers
  must still fetch the manifest OIDs.
- Roll back while readers consume the new release; each reader sees one whole
  manifest.

## Graduation metrics

| Gate               | Required result                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------- |
| Reader consistency | Across 100 concurrent readers and 100 end-to-end plus 1,000 model publications, mixed views are zero |
| Publication CAS    | Two same-generation producers yield exactly one winner and one conflict                              |
| Fetchability       | Every admitted commit remains fetchable after source branch deletion and force-push                  |
| Git integrity      | All ten checked-out repositories pass `git fsck --full --strict` and match manifest OIDs             |
| Retry              | Ambiguous retry returns the same manifest digest and receipt without a second publication            |
| Rollback           | Current release reverts to a prior complete manifest in under one second after preparation           |
| Resolver overhead  | Warm p95 resolution adds less than 100 ms before repository fetches                                  |
| Adoption           | One real consumer reads only through the pinned resolver during the experiment                       |

The last gate is product-critical. A perfect coordinator with no resolver
adoption does not provide consistency.

## Fatal risks and kill gates

Stop when:

- a target consumer continues reading repository branch heads directly;
- an external host cannot provide a durable, fetchable anchor for a prepared
  commit;
- the design claims to roll back or atomically update external branches;
- submodules or an existing signed lockfile meet the same job;
- repository policy changes between prepare and publish cannot be represented
  or safely revalidated;
- a central resolver is unacceptable for availability, trust, or workflow
  reasons;
- signing, key rotation, authorization, and audit requirements dominate the
  Git coordination problem;
- no design partner has suffered a concrete half-release failure worth
  changing its consumption path.

## Verdict

**NO-GO without a resolver-accepting design partner; conditional GO for the
manifest spike only.** This may be a useful release-control product, but it is
not evidence for a new browser Git engine. Its honest guarantee is atomic
publication of one pinned multi-repository manifest, never atomic mutation of
unrelated external Git hosts.

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
