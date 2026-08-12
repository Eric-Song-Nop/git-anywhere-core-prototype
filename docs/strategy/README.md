# Git Anywhere strategy options

<!-- markdownlint-disable MD013 -->

Status: exploratory, not a committed product roadmap.

This directory asks a narrower question than the prototype at the repository
root:

> Which user-visible outcome could justify a Git storage core that is more
> complex than using `wasm-git` or stock Git directly?

That framing is intentional. The current repository proved a storage contract:
immutable Git objects can be separated from transactionally published refs,
and ambiguous writes can be retried without duplicating publication. It did
**not** prove that a new browser Git client should exist. Current
[`wasm-git`](https://github.com/petersalomonsen/wasm-git) already ships a
compact libgit2-based browser runtime with persistent OPFS variants and real
clone, edit, commit, fetch, and push workflows.

The strategy therefore starts from three rules:

1. adopt or complement existing Git engines instead of recreating their
   command surface;
2. compete only where storage semantics produce a result users can measure;
3. kill an option when its time-boxed experiment misses a predeclared gate.

Throughout this packet, **metadata authority** means the transactional control
plane that owns refs, HEAD, generations, manifests, fences, and typed receipts.
**Immutable byte plane** means the content-addressed objects, packs, indexes,
and bundles that become reachable only after that authority publishes them.

## Reading order

1. [Competitive baseline](00-competitive-baseline.md) — what `wasm-git`,
   stock Git, and the current prototype actually provide.
2. [Transactional storage for wasm-git](01-transactional-wasm-git-storage.md)
   — keep libgit2 and replace weak persistence/coordination boundaries.
3. [Zero-clone branch transactions](02-zero-clone-branch-transactions.md) —
   read and change a path without materializing a repository.
4. [Verified cross-provider backup](03-verified-cross-provider-backup.md) —
   preserve deleted/force-pushed history and continuously prove restoration.
5. [BYOS data-sovereignty Git](04-byos-data-sovereignty-git.md) — standard Git
   with object bytes in a customer's own storage account.
6. [Cloudflare Durable Object deployment profile](05-durable-object-git-authority.md)
   — one serverless deployment of the metadata-authority/immutable-byte-plane split
   described by the BYOS direction.
7. [Global read edge](06-global-read-edge.md) — immutable pack distribution
   with generation-pinned ref snapshots.
8. [Pinned multi-repository release manifest](07-cross-repository-release-graph.md)
   — one atomic manifest across multiple repository revisions.
9. [Storage conformance lab](08-storage-conformance-lab.md) — a low-risk,
   non-product fallback that turns the failure corpus into public leverage.
10. [Rejected directions](rejected-directions.md) — ideas that sound adjacent
    but do not justify this core.
11. [Shared validation program](09-validation-program.md) — one corpus,
    fault model, oracle, and reporting format for every experiment.
12. [Recommended sequencing](10-recommendation.md) — what to try first, what
    can run later, and when to archive the implementation.

## Product taxonomy

The options are not peers. A product, a feature of that product, a deployment
profile, and a fallback project must not compete for one ordinal rank.

### Product hypotheses

1. **Transactional browser persistence for `wasm-git`.** Extend the incumbent
   browser engine only for applications that can demonstrate a large-repository
   hydration or cross-context correctness problem.
2. **Transactional Git authority.** A headless service that owns refs and pack
   manifests, serves standard Git, and publishes immutable bytes before one
   atomic metadata decision. Zero-clone writes and edge distribution are
   optional features of this product; BYOS and Durable Objects are deployment
   profiles.
3. **Verified cross-provider Git backup.** A separate recovery product whose
   value is independent restore and continuing restore evidence, not ordinary
   Git hosting.
4. **Pinned multi-repository release manifest.** An adjacent orchestration
   product for consumers willing to resolve releases through one immutable
   manifest. It does not atomically mutate unrelated hosts.

### Features, deployments, and fallback

- **Authority features:** zero-clone branch transactions and a standards-first
  global read edge.
- **Authority deployments:** customer-owned byte/metadata services (BYOS) and a
  Cloudflare Durable Object plus R2 profile.
- **Non-product fallback:** the storage conformance lab. It becomes eligible
  when a primary product track stops, passes its own two-week technical gates,
  and survives beyond 30 days only when another maintainer adopts a scenario
  or an upstream project accepts a minimized finding.

## Evidence map

`Validate now` means “run a bounded experiment after its demand prerequisite
passes,” not “build a roadmap.” A direction with no design partner remains
conditional regardless of technical reuse.

| Hypothesis or component                  | Category             | Demand prerequisite                                                         | Incumbent to beat                                      | Evidence status               |
| ---------------------------------------- | -------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------- |
| Transactional `wasm-git` persistence     | Product              | One browser app supplies a measured hydration or cross-context failure      | Current `wasm-git` variant plus Web Locks              | Validate now, after partner   |
| Transactional Git authority              | Product              | One operator needs a non-POSIX authority or controlled immutable byte plane | Stock Git service, container, JGit DFS, hosted forge   | Server-engine viability first |
| Zero-clone branch transaction API        | Authority feature    | One ephemeral workload accepts an authority-owned repository                | Partial clone; GitHub/GitLab commit APIs               | Validate with authority       |
| Verified cross-provider backup           | Product              | Buyer gives Git-only scope plus RPO, RTO, retention, and restore target     | Forge-native and commercial repository-backup products | Conditional product           |
| BYOS/data-sovereignty                    | Deployment profile   | Customer requires bytes and authority in customer-selected services         | Gitaly/JGit DFS/stock Git with ephemeral cache         | Conditional deployment        |
| Durable Object plus R2                   | Deployment profile   | Partner specifically requires Cloudflare/serverless per-repository routing  | Stock Git in a container or conventional Git service   | Conditional deployment        |
| Global read edge                         | Authority feature    | Fleet shows measured origin egress or cross-region latency                  | Bundle URI, partial clone, mirror, ordinary CDN cache  | Later feature                 |
| Pinned multi-repository release manifest | Adjacent product     | Consumer agrees to resolve only through a pinned manifest                   | Submodules, signed lockfile, existing GitOps manifests | Conditional product           |
| Storage conformance lab                  | Non-product fallback | A primary product track stops and leaves an extractable failure corpus      | Upstream project-specific test suites                  | Fallback entry only           |

No score rewards preserving the current Go-WASM, Rust-WASM, OpenDAL, OPFS, or
IndexedDB implementation. The recommendation weighs demonstrated user pain,
incumbent gap, adoption friction, technical feasibility, and operating cost;
unknown demand is a blocking unknown rather than a neutral score.

## What is deliberately not preserved

The Go-WASM plus Rust-WASM split, OpenDAL, OPFS, and IndexedDB are implementation
choices, not product requirements. A winning experiment may replace all of
them. The durable assets are smaller:

- immutable bytes become visible only after metadata publication;
- generation, revision, and expected-ref comparisons prevent stale writes;
- idempotency receipts resolve ambiguous acknowledgements;
- fault injection checks every publication cut;
- canonical Git object IDs and `git fsck --full --strict` are external oracles.

No direction graduates because it is technically interesting. It graduates
only when its own document's measurable user and interoperability gates pass.
