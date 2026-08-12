# Authority feature: zero-clone branch transactions

<!-- markdownlint-disable MD013 -->

> Status: transactional-authority feature hypothesis, not a roadmap commitment. This direction is
> worthwhile only if it beats the best applicable partial-clone baseline on a
> real user job. Merely avoiding the `git clone` command is not a product win.

## Product boundary, target user, and job

This is a **feature of the transactional Git authority**, not an independent
client or a transparent accelerator for arbitrary GitHub/GitLab repositories.
The authority owns repository refs, immutable bytes, and publication receipts.
Standard Smart HTTP remains available; the structured transaction API is an
additional fast path for repositories already hosted by that authority.

The initial target is one code-transformation or serverless-workspace service
that creates many short-lived jobs and edits no more than ten paths per job.
CI, browser IDEs, and remote explorers are adjacent segments, not evidence that
the first implementation serves all of them.

Its job is: **open one revision of a large repository, read a bounded set of
paths, publish a branch containing a small edit, and terminate without
materializing an entire repository or worktree**.

The relevant pain is repeated repository hydration. A one-minute checkout that
precedes a five-second transformation is expensive even when the checkout is
shallow. The proposed feature has no value for a developer who already has a
warm local clone.

Before implementation, a named design partner must provide a reproducible job,
repository shape, current transfer/time/cost measurements, required author and
branch-policy behavior, and willingness to host or mirror the experiment in the
candidate authority. If the partner cannot move the authoritative ref or accept
an authority-managed mirror, stop: provider neutrality cannot be manufactured
by a client-side SDK.

## Competitive baseline

The baseline is stronger than a naive full clone:

- stock Git supports partial clone filters such as `--filter=blob:none`, sparse
  checkout, protocol v2 negotiation, and bundle/packfile URIs;
- GitHub exposes Git Database APIs and a GraphQL
  [`createCommitOnBranch`](https://docs.github.com/en/graphql/reference/commits)
  mutation that applies file changes and compares an `expectedHeadOid` without
  a clone;
- GitLab exposes repository-files and commits APIs for forge-hosted changes;
- wasm-git packages libgit2 for browsers and Node.js, including OPFS variants
  and documented clone/edit/commit/push flows;
- a provider-specific service can build a commit with the GitHub Git Database
  API without running any Git engine locally.

Therefore the claim cannot be “Git without checkout.” The candidate must be
faster than the best working stock-Git or forge-specific option for the same
operation and valuable enough to justify authority adoption. The first spike
must record which partial-clone and sparse options actually work in the selected
native Git and `wasm-git` builds; unsupported options must not silently become a
straw-man baseline. Provider neutrality is not a graduation claim until two
provider adapters independently pass later conformance tests.

## Precise product promise

Given a repository revision and a bounded path set, a client can:

1. resolve the exact ref snapshot;
2. fetch only the objects or pack ranges required for those paths;
3. create canonical Git blobs, trees, and a commit without a worktree;
4. publish one or more refs using expected-old values and an idempotency key;
5. recover the exact result after an ambiguous timeout; and
6. let an unmodified Git client fetch and validate the published commit.

The promise does **not** include arbitrary Git CLI compatibility, hooks, a POSIX
filesystem, or transparent acceleration of every repository. Repositories with
very wide root trees, pathological delta chains, submodules, or server-side
filters that do not support the requested object access may fall back or be
rejected explicitly.

## Proposed architecture and data flow

```text
short-lived client
  │  open(ref, expected generation)
  ▼
transactional ref authority
  │  immutable snapshot: ref OID + generation/revision
  ▼
object/pack resolver ── range/OID reads ──► immutable object store or CDN
  │
  ├─ decode only required commit/tree/blob objects
  ├─ write new blob + rewritten ancestor trees + commit
  └─ verify hashes and connectivity
  │
  ▼
publish(requiredObjects, expectedRefs, receiptKey)
  │
  └─ one metadata transaction advances refs or returns a conflict/replay
```

Reads pin one metadata snapshot before resolving immutable bytes. Writes upload
and verify every new object before the ref transaction. A standard Smart HTTP
surface remains the interoperability boundary; a structured object API is an
additional fast path, not a replacement for Git compatibility.

The owned-authority boundary is essential. Against an external forge, the
candidate uses that forge's commit/ref API and inherits its retry, policy, and
publication semantics. It cannot promise the authority's exact receipt replay
or multi-record transaction while another provider owns the ref.

Pack and cache design is central. Loose-object-per-request access is acceptable
for the spike but cannot be the production plan. A production resolver needs
pack indexes, bounded range reads, delta resolution, streaming verification,
negative-cache rules, and generation-aware cache keys. Protocol v2 packfile
URIs are relevant, but Git documents that mechanism as experimental, so the
design must not depend on universal client support.

## Reuse and discard from the current prototype

### Reuse

- the custom storage-interface contract and its tests, without presuming the
  go-git runtime;
- canonical blob/tree/commit encoding and independent OID verification;
- immutable-object-before-ref-publication ordering;
- generation, revision, and expected-ref CAS;
- idempotency receipts and ambiguous-response replay;
- browser Worker/restart tests and the canonical `git fsck --full --strict`
  oracle.

### Discard or treat only as test scaffolding

- the fixed `proof.txt` commit API;
- the demo tree viewer as a product surface;
- loose, whole-object envelope storage as the long-term layout;
- whole-object copies across JavaScript, Go-WASM, and Rust-WASM;
- the assumption that two WASM modules are the universal runtime;
- OPFS and IndexedDB as the only backends;
- SHA-1-only support as a permanent contract.

The current code proves publication semantics, not lazy large-repository
performance. That distinction must remain explicit.

## Two-week vertical spike

The spike starts only after the named-partner gate passes and implements exactly
one end-to-end path:

1. Generate and publish a deterministic large repository corpus.
2. Expose ref snapshot and object-by-OID reads from a minimal gateway.
3. In a fresh client process matching the partner deployment (a new Chrome
   profile when the client is browser-based), open `main`, resolve one nested
   text file, and read its bytes without invoking clone.
4. Replace that file, rewrite only the affected tree path, create a commit, and
   race two publishers against the same old ref.
5. Require one winner and one structured conflict; retry the winner with the
   original key and require the exact receipt.
6. Fetch the winning ref with stock Git and run strict fsck.
7. Run fair stock Git partial/sparse, `wasm-git`, GitHub
   `createCommitOnBranch`, and an applicable GitLab/forge commit-API baseline on
   the same corpus and cold-cache policy. Provider APIs are measured from their
   supported hosting environment and reported separately from self-hosted
   network shaping; no cross-provider latency claim is made from unlike regions.

The spike may use loose objects behind its gateway. It must still measure the
request-count penalty and produce a pack/range design before a go decision.

## Benchmark corpus and metrics

The corpus generator, seed, resulting ref OIDs, and full-pack byte length must
be checked in or published with the result. Minimum shape:

- at least 1 GiB of reachable content;
- at least 100,000 Git objects;
- at least 50,000 paths with depth and fan-out distributions recorded;
- at least 1,000 commits, including renames and repeated content;
- one target edit of approximately 10 KiB at depth four or greater.

Measure from a fresh process or browser profile matching the design partner:

| Metric                         | Go threshold                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------- |
| Bytes to first target file     | no more than 2% of the full pack and at least 5x lower than the fastest applicable baseline        |
| Time to first target file, p95 | candidate p95 / fastest applicable baseline p95 <= 0.50                                            |
| Peak client memory             | no more than 256 MiB for the target operation                                                      |
| Bytes uploaded for one edit    | new blob/commit plus affected ancestor-tree bytes and no unrelated blobs                           |
| Concurrent publication         | 32 independent clients; 100 end-to-end plus 1,000 model attempts; zero lost/torn/duplicate writes  |
| Fault recovery                 | every injected pre/post-publication timeout resolves to conflict, success, or exact receipt replay |
| Compatibility                  | stock Git fetch succeeds and strict fsck reports no error                                          |
| Adoption                       | the design partner runs its real job against the authority and confirms the measured win           |

Report medians and p95/p99 values, raw samples, request counts, CPU time, peak
memory, cold bootstrap bytes, and storage reads. A custom gateway must be
included in the total cost and latency accounting.

## Failure, security, and operational risks

- **Partial clone may already be sufficient.** If stock Git with filters meets
  the job, a custom object API has no justification.
- **Wide trees defeat “small edit” economics.** Rewriting one path may require
  downloading and uploading large ancestor trees.
- **Delta and pack complexity is substantial.** Incorrect thin-pack or delta
  handling can produce reachable corruption that a happy-path test misses.
- **Stale refs must never be cached as immutable.** Only OID-addressed bytes and
  generation-pinned snapshots are safe CDN keys.
- **OID probing can leak repository membership.** Authorization must cover
  object reads, not only refs, and errors must not reveal cross-tenant presence.
- **Malicious objects are untrusted input.** Bound object size, delta depth,
  decompression ratio, tree width, commit headers, request fan-out, and CPU.
- **SHA-1 repositories require collision-aware handling.** New-format support
  and algorithm-tagged keys are needed before a broad product claim.
- **CORS and credentials remain deployment constraints.** The browser must not
  receive long-lived object-store credentials.
- **Cold runtime size can erase the win.** The current Go-WASM artifact is far
  larger than wasm-git's advertised OPFS modules; bootstrap must be measured.

## Go/no-go and stop conditions

Proceed only if every correctness gate passes, the design partner adopts the
authority-backed experiment, and both byte and time advantages hold against the
fastest applicable baseline. A win against full clone but a loss against partial
clone or a forge commit API is a no-go. For each comparable baseline, report
`candidate / baseline`; the go threshold is `<= 0.50` for p95 time and `<= 0.20`
for transferred bytes. Do not combine unlike regions into one ratio.

Stop this direction if any of the following is true:

- the target operation has `candidate / fastest-baseline > 0.50` for p95 time
  or `> 0.20` for transferred bytes;
- the implementation must hydrate a complete repository or persistent
  worktree before each mutation;
- standard Git cannot fetch the result without repository-specific repair;
- concurrency safety requires serializing all clients through one warm process
  rather than using the metadata authority;
- bootstrap cost consumes most of the measured latency advantage;
- the design partner will not place authoritative refs in the service or its
  controlled mirror;
- the only working deployment requires a proprietary remote with no plausible
  standard-Git fallback or adoption path.

## Primary sources

- [Git clone: partial clone filters and sparse checkout](https://git-scm.com/docs/git-clone.html)
- [Git protocol v2](https://git-scm.com/docs/protocol-v2.html)
- [Git packfile URIs](https://git-scm.com/docs/packfile-uri.html)
- [Git bundle URI design](https://git-scm.com/docs/bundle-uri)
- [GitHub Git Database REST API](https://docs.github.com/en/rest/git)
- [GitHub Git tree API](https://docs.github.com/en/rest/git/trees)
- [GitHub GraphQL commit mutation](https://docs.github.com/en/graphql/reference/commits)
- [GitLab commits API](https://docs.gitlab.com/api/commits/)
- [wasm-git repository and current documented runtime variants](https://github.com/petersalomonsen/wasm-git)
- [JGit 7.7.1 DFS implementation package](https://github.com/eclipse-jgit/jgit/tree/v7.7.1.202607240634-r/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/dfs)

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
