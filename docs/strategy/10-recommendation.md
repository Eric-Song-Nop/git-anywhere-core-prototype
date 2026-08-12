# Recommended sequencing

<!-- markdownlint-disable MD013 -->

Status: proposed for owner review; not an accepted roadmap or funding decision.

This recommendation optimizes for learning, not for preserving the current
implementation. It is exploratory and reversible.

## Decision

Do not rank features, deployments, and fallback infrastructure as peer product
bets. Validate at most two product hypotheses now, and only after demand is
observable:

1. transactional browser persistence beneath `wasm-git`; and
2. a transactional Git authority, exercised first through its zero-clone branch
   transaction feature.

Verified cross-provider backup is a separate conditional product. BYOS and
Durable Objects are authority deployment profiles; global read edge is an
authority feature; the pinned multi-repository release manifest is an adjacent
product; the conformance lab is a non-product fallback.

## Demand prerequisite

No implementation clock starts until each active track has one named design
partner and one reproducible workload.

### Track A partner evidence

The browser application must provide:

- a non-cross-origin-isolated deployment, or allow the pthread/WASMFS control;
- a repository with at least 1 GiB reachable data and 100,000 objects;
- measured cold-reopen bytes/time/memory or a competing-tab failure;
- a required guarantee that Web Locks plus stock `wasm-git` cannot satisfy; and
- an engineer who will run the candidate against the real application.

### Track B partner evidence

The ephemeral transformation/workspace service must provide:

- one job that reads and changes no more than ten paths in a large repository;
- current stock partial/sparse clone and forge-commit-API measurements;
- required auth, author, branch-policy, latency, transfer, and cost constraints;
- willingness to host or mirror authoritative refs in the candidate service;
  and
- an engineer who will adopt the vertical experiment if it wins.

If a track cannot obtain that evidence, mark it `STOP`; technical curiosity does
not substitute for demand.

## Evidence scorecard

Use this scorecard to route experiments, never to waive a hard correctness gate.
Record evidence links beside every score.

| Dimension           | 0                                 | 1                                      | 2                                                     |
| ------------------- | --------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| User pain           | no named user                     | stated pain, no reproducible workload  | named partner plus measured reproducible workload     |
| Incumbent gap       | incumbent meets requirement       | material gap is plausible but untested | same-workload measurement proves the gap              |
| Adoption            | required workflow change rejected | partner accepts bounded trial          | partner completes real-workload trial                 |
| Technical viability | known fatal blocker               | decisive seam remains unknown          | vertical path passes every applicable hard gate       |
| Economics           | outside buyer/platform constraint | cost or SLO unknown                    | absolute SLO and predeclared cost threshold both pass |

A track may enter a two-week spike only with `User pain = 2`, `Adoption >= 1`,
and no known fatal blocker. It may graduate only when every hard gate in its
direction document passes, no dimension is zero, and the total is at least 8/10.
Prototype code reuse contributes zero points.

## Two parallel, bounded experiments

### Track A — transactional persistence beneath `wasm-git`

Keep the existing libgit2 browser engine. On the exact large-repository segment,
test whether a narrow ODB/refdb integration can avoid complete Git-database
hydration, fence cooperating contexts, and rebuild stale worktree/index caches
without maintaining an untenable fork.

The authoritative guarantee covers committed objects, packs, refs, HEAD, and
publication receipts. It does not silently promise preservation of dirty
worktree state. Use the workloads and gates in
[transactional storage beneath wasm-git](01-transactional-wasm-git-storage.md).

### Track B — transactional authority plus zero-clone feature

Spend the first 2–3 days on the shared
[server-engine viability gate](09-validation-program.md#0-server-engine-viability-gate).
If bounded upload-pack/receive-pack, quarantine, and one atomic two-ref
publication seam fail, stop the custom authority and select canonical Git/JGit.

If the gate passes, build only this vertical path:

```text
open authority-owned snapshot
  → read one path
  → replace its blob and ancestor trees
  → create a commit
  → race two expected-head publications
  → fetch and verify the winner with stock Git
```

Benchmark stock partial/sparse clone, `wasm-git`, GitHub
`createCommitOnBranch`, and an applicable GitLab/forge commit API. Do not claim
provider neutrality from an authority-owned proof. Use the workloads and gates
in [zero-clone branch transactions](02-zero-clone-branch-transactions.md).

## Decision outcomes

| Result            | Action                                                                                              |
| ----------------- | --------------------------------------------------------------------------------------------------- |
| A passes, B fails | Pursue a narrow `wasm-git` storage contribution with a funded maintenance owner                     |
| B passes, A fails | Continue the transactional authority; keep zero-clone as one optional API beside standard Git       |
| Both pass         | Keep them separate until a partner proves browser persistence and remote authority should integrate |
| Both fail         | Archive the runtime, preserve the conformance evidence, and adopt `wasm-git`/stock Git              |

A near miss gets one scoped iteration only when evidence identifies one bounded
bottleneck. It does not receive another open-ended two-week cycle.

## Conditional products and profiles

Do not begin these merely because their designs are interesting:

- **Verified backup:** proceed only for a buyer that accepts Git-only scope and
  supplies provider targets, RPO, RTO, retention, and cost; compare commercial
  backup products as well as scripts and forge-native tools.
- **BYOS deployment:** proceed only after the server-engine gate passes and a
  customer requires customer-owned byte and metadata services.
- **Durable Object deployment:** proceed only when a partner specifically needs
  Cloudflare/serverless per-repository authority and its push-size distribution
  fits the selected account-plan request-body cap.
- **Global read-edge feature:** proceed only from measured fleet latency/egress
  and try Bundle URI, partial clone, a mirror, and an ordinary CDN first.
- **Pinned multi-repository release manifest:** proceed only when a consumer
  agrees to resolve every repository revision through the pinned manifest.
- **Conformance lab:** extract only as the fallback; keep it beyond 30 days only
  after an upstream finding or external scenario adoption.

## Budget discipline

The current Go-WASM and Rust-WASM modules are not protected investments. Keep
or replace them solely by measured merit. In particular:

- do not add browser porcelain to catch up with libgit2;
- do not retain OpenDAL when a platform-native byte API is simpler;
- do not call local multi-tab serialization a standalone product;
- do not describe a feature or deployment as an independent product;
- do not generalize the demo before a product bet passes; and
- do not turn an experiment into a hosted Git service by accident.

The one asset worth preserving under every outcome is the failure discipline:
immutable-before-metadata publication, expected-state comparison, typed exact
retry receipts, crash cuts, and an independent stock Git oracle. Ordinary Git
push retry remains expected-old comparison plus ref inspection; it must not be
misrepresented as typed idempotency.

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md)
