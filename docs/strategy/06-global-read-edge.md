# Authority feature: global Git read edge

<!-- markdownlint-disable MD013 -->

Status: later-stage distribution feature for an existing Git authority,
justified only by measured clone/fetch latency and origin egress.

## Decision

Do not build another Git storage engine for this direction. Start with the
standard Git Bundle URI mechanism, immutable bundles in an object store/CDN,
and the existing origin as the final source of truth. Promote this into a
production feature only when real traffic shows a material global read problem
and bundle selection or generation becomes a differentiator.

If a static Bundle URI deployment solves the workload, that is a successful
operations feature and a reason to retire the prototype core, not to preserve
it.

## User and job

The user is a globally distributed CI fleet, developer organization, cloud
IDE, or code-indexing service cloning and fetching the same large repositories
from a distant origin.

Their job is:

> Reach useful repository state quickly from any region while reducing origin
> CPU and egress, without trusting a stale cache as the ref authority and
> without requiring a proprietary Git client.

The user-visible outcomes are time to checkout or first requested object,
total clone/fetch time, and bytes served by the origin.

Before implementation, one named fleet must supply client Git versions,
repository/update distributions, regional traffic, origin CPU/egress cost, cache
hit rate, and target latency. It must also agree to test a standards-compatible
bundle path. Synthetic 200 ms RTT alone is not demand evidence.

## Why wasm-git alone does not solve it

`wasm-git` brings libgit2 and local persistence into a browser. It does not
place remote packs near users, precompute reusable negotiation results,
invalidate shared caches, or give an origin a consistent publication token.
Every browser can have an excellent local Git engine and still wait on the
same distant server.

Conversely, this edge does not replace `wasm-git`. A browser client may still
use it after data arrives. Bundle URI support in stock Git does not prove that
the current `wasm-git`/libgit2 build supports the feature; browser benefit must
be measured separately and must not require claiming an untested protocol
capability.

## Standards-first architecture

```text
                     +--------------------------+
                     | canonical Git authority  |
                     | refs + Smart HTTP origin |
                     +-------------+------------+
                                   |
                       generation N immutable view
                                   |
                     +-------------v------------+
                     | bundle/index builder      |
                     | stock Git pack machinery  |
                     +-------------+------------+
                                   |
             immutable bundle(s), list, checksum, generation
                                   |
             +---------------------v---------------------+
             | object storage + HTTP CDN / regional edge |
             +---------------------+---------------------+
                                   |
                          stock Git clients
                    bundle bootstrap, then origin fetch
```

The origin remains authoritative for current refs. Edge artifacts are
immutable accelerators. A client bootstraps its object database from bundles,
then negotiates with the origin for anything newer or absent.

### Use Bundle URI before inventing a protocol

Git's [Bundle URI specification](https://git-scm.com/docs/bundle-uri) already
supports the important pieces:

- `git clone --bundle-uri=<uri>` for an explicit bootstrap;
- origin advertisement through a Git protocol v2 capability;
- a single bundle or a bundle list;
- `bundle.mode=any` for geographic alternatives and `bundle.mode=all` for a
  required set;
- immutable full and incremental bundles ordered by `creationToken`;
- ordinary HTTP(S) serving, including static CDN content;
- graceful fallback to the Git origin when a bundle is missing or invalid.

The Bundle URI design describes filter-associated variants, but Git 2.55.0's
bundle-list parser does not select entries by filter. Treat that association as
future/upstream work, not as current client support.

A [Git bundle](https://git-scm.com/docs/git-bundle) is a pack plus refs and
prerequisite metadata that stock Git can clone or fetch from. Generate it with
stock Git and retain its checksum; do not write a novel pack encoder during
the spike.

Bundle URI is intentionally not the ref authority. A stale but valid bundle
can save bytes and still require a catch-up fetch. CDN cache keys should be
content- or generation-addressed; mutable "latest" pointers may be cached for
discovery but never define repository truth.

### Generation-pinned reads are an optional product layer

For application APIs that make several object reads, the authority may issue
a token containing a repository generation, ref snapshot, bundle-set digest,
and expiry. Every edge read for that token resolves against the same immutable
manifest. This prevents an application from mixing object indexes published
by different repacks.

That token is not a standard Git feature. Standard Git clone/fetch should
continue using Bundle URI plus the origin negotiation. Do not make native Git
depend on a proprietary resolver merely to claim consistency.

## Reuse and throwaway

| Reuse                                       | Adapt                                                   | Throw away                         |
| ------------------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| Immutable-object and publish-last reasoning | Generation/revision into bundle-set manifests           | Browser IndexedDB metadata store   |
| Required-object validation                  | Fault cuts into build/upload/manifest/fetch stages      | OPFS and Rust OpenDAL runtime      |
| Canonical OID and strict-fsck oracle        | Read receipts into cache telemetry, not write semantics | Fixed commit API and demo UI       |
| Separation of bytes from mutable refs       | Object backend into a CDN/object-store publisher        | New browser Git-client positioning |

The current Go-WASM object facade is not a prerequisite. Stock Git's mature
pack and bundle machinery is the baseline and should generate the artifacts.

## Competitive and standards baseline

The candidate is mostly an application of existing standards:

1. **Git Bundle URI** is the primary baseline and likely implementation.
2. **Partial clone** already avoids downloading unneeded objects and can
   demand-fetch them from promisor remotes. See Git's
   [partial-clone design](https://git-scm.com/docs/partial-clone) and
   [`git clone --filter`](https://git-scm.com/docs/git-clone).
3. **Packfile URIs** are described in Bundle URI's related work, but couple
   the origin response more tightly to externally served packs. Do not choose
   them without a workload Bundle URI cannot cover.
4. **An ordinary regional mirror or CDN in front of Smart HTTP** is the
   simplest operational comparison.

The differentiator cannot be "packs on a CDN." It would have to be better
bundle scheduling, filter selection, geographic routing, consistency
telemetry, or integration with a real repository fleet.

## Two-week spike

Use the large-source and history-heavy corpora from the shared validation
program. Test at least three simulated client regions with 200 ms origin RTT
and a nearby object-store/CDN endpoint.

### Build

- Produce one full bundle and, if the pinned stock client can consume it, one
  explicitly selected `blob:none` bundle from a recorded authority generation.
  Do not assume the current bundle-list parser automatically selects entries by
  their advertised filter; Git 2.55.0 recognizes URI and creation token while
  [filter-aware bundle-list selection remains design work](https://github.com/git/git/blob/v2.55.0/Documentation/technical/bundle-uri.adoc#L148-L152).
- Produce an incremental bundle after each of at least 24 synthetic update
  intervals and publish a `creationToken` bundle list.
- Serve all artifacts as immutable HTTP objects with checksums and explicit
  cache policy.
- Configure a compatible stock Git client with an explicit Bundle URI. Add
  origin advertisement only if the selected server already supports it.
- Optionally issue a generation token for the structured object-read API; keep
  that experiment separate from standard Git behavior.

### Exercise

- Cold full clone, cold blobless clone, and checkout of a selected sparse path.
- Hourly incremental fetch, a client 24 intervals behind, and a client newer
  than the latest bundle.
- Missing, truncated, corrupt, unauthorized, and stale bundle responses; every
  case must fall back safely to the origin.
- Concurrent origin ref update while a new bundle set is uploaded; no manifest
  may name a partially uploaded bundle set.
- Regional `bundle.mode=any` selection and failover to another region.
- Fresh stock Git clone and `git fsck --full --strict` after every path.

Run the same corpus against direct origin clone, origin plus an ordinary HTTP
cache, and partial clone without bundles.

## Graduation metrics

| Gate                   | Required result                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Client compatibility   | Unmodified pinned stock Git consumes the supported bundle/list and catches up from the origin; any blobless variant is selected explicitly unless filter-aware lists become supported |
| Cold performance       | candidate/direct-origin p95 full-clone time <= 0.50 at 200 ms origin RTT                                                                                                              |
| First useful data      | candidate/fastest-baseline p95 time to selected sparse path <= 0.50                                                                                                                   |
| Origin relief          | Warm-fleet origin object bytes fall by at least 90% and origin pack CPU by at least 80%                                                                                               |
| Incremental efficiency | A one-interval-behind client downloads no full historical bundle again                                                                                                                |
| Correctness            | Every result passes strict fsck and refs match the authority after catch-up                                                                                                           |
| Failure behavior       | Missing/corrupt/stale edge artifacts never become authority and always fall back correctly                                                                                            |
| Publication            | 1,000 manifest upload crash cuts expose only the old or complete new bundle set                                                                                                       |
| Total cost             | bundle build + CDN + residual-origin cost <= 0.80x the direct-origin workload cost                                                                                                    |
| Adoption               | the named fleet completes a real supported-client trial without a proprietary Git client                                                                                              |

Report CDN bytes as well as origin bytes. Moving the same waste to a cheaper
provider is not a latency win, and a latency win whose build/CDN cost exceeds
the fleet's predeclared budget does not graduate.

## Fatal risks and kill gates

Stop or narrow the direction when:

- the target client fleet cannot consume Bundle URI and would require a custom
  client or private libgit2 fork;
- the required filter-aware list behavior exists only in design documentation
  rather than the pinned stock client's parser;
- partial clone, a regional mirror, or an ordinary cache already meets the
  performance and egress target;
- bundle creation CPU/storage costs exceed the saved origin work;
- high update frequency makes bundles stale before clients reuse them;
- authentication prevents cache reuse or leaks object existence across
  tenants;
- clients routinely redownload overlapping bundles, erasing the byte win;
- the implementation begins making CDN state authoritative for refs;
- the business has no measured global latency or egress problem.

## Verdict

**Conditional GO as a standards-based edge experiment; NO-GO as a reason to
continue the current Git engine.** Bundle URI, partial clone, stock pack
generation, and a CDN should do nearly all of the work. Only real fleet data
can justify a scheduling and consistency product around those standards.

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
