# Shared validation program

<!-- markdownlint-disable MD013 -->

Every strategy experiment should use the same corpus generator, failure
vocabulary, and external Git oracle, but only the profiles relevant to its
claim. Without that discipline it is too easy to declare a win by changing the
workload or ignoring a hard part of Git; requiring every two-week spike to run
every large profile would instead reward shallow checkbox coverage.

## 0. Server-engine viability gate

Run this shared 2–3 day gate once before implementing the transactional Git
authority, its zero-clone feature, or its BYOS/Durable Object deployments. The
purpose is to identify a bounded server-side Git engine seam before investing
in storage adapters.

On one small correctness repository and one at least 64 MiB packed fixture:

1. Select the smallest credible engine path: canonical Git behind a controlled
   process/container, JGit DFS, or a bounded go-git/other library adaptation.
2. Serve upload-pack/fetch over Smart HTTP, using protocol v2 where the selected
   engine supports it, and receive one ordinary receive-pack push from stock Git.
3. Stream or use explicitly bounded scratch for the pack; do not materialize a
   persistent full repository as the proposed authority unless that path is the
   declared canonical-Git control.
4. Quarantine and reject a corrupt pack, a missing required object, a stale old
   OID, and a non-fast-forward update before any ref reaches invalid bytes.
5. Exercise an ordinary two-ref push with truthful per-ref status and a
   client-requested `git push --atomic` whose two refs change together or not at
   all. Identify the exact engine callback/transaction boundary that can publish
   the accepted ref set plus its pack manifest.
6. Lose the response after publication. The stock-Git path must converge by ref
   inspection; exact receipt replay is tested only through a typed API or an
   explicitly supported stable push option.
7. Record patch size, private engine files touched, peak memory, temporary disk,
   CPU, request bytes, and the same-region canonical Git/JGit control result.

The gate passes only if stock Git can clone/fetch/push and strictly verify the
result, pack processing is bounded, and the atomic publication seam does not
require a broad private fork. Otherwise select canonical Git/JGit as the service
engine or stop the split-authority direction. A successful loose-object or
custom-client demo does not pass.

## 1. Benchmark corpus

Generate repositories rather than relying only on public projects. The
generator must record its seed and expected object IDs so every implementation
sees identical input.

Minimum profiles:

| Profile           | Purpose                            | Required shape                                                       |
| ----------------- | ---------------------------------- | -------------------------------------------------------------------- |
| Small correctness | Exhaustive fault tests             | nested trees, executable, symlink, tag, branches, merge, binary blob |
| Large source      | Cold-open and selective-read tests | at least 1 GiB reachable data and 100,000 objects                    |
| History-heavy     | negotiation and GC                 | at least 100,000 commits with repeated tree reuse                    |
| Ref-heavy         | transaction tests                  | at least 10,000 branches/tags and D/F name conflicts                 |
| Pack-adversarial  | parser and memory bounds           | ofs/ref deltas, thin pack, deep chains, corrupt trailer/index        |

Record full-pack bytes, reachable bytes, object count, ref count, canonical
`git count-objects -vH`, and a successful `git fsck --full --strict` before a
corpus enters the suite.

### Applicability matrix

`Required` means the two-week decision uses that shared profile. `Own` means
the direction document defines a narrower or differently shaped corpus for the
same risk. `Later` means the risk is acknowledged but waits for a passed
vertical spike. A blank cell means the profile does not test the claim.

| Direction                            | Small    | Large source | History-heavy | Ref-heavy | Pack-adversarial |
| ------------------------------------ | -------- | ------------ | ------------- | --------- | ---------------- |
| Transactional `wasm-git` persistence | Required | Required     | Later         | Later     | Own              |
| Transactional authority engine gate  | Required | Own          |               | Own       | Own              |
| Zero-clone authority feature         | Required | Required     |               |           | Later            |
| Verified backup                      | Required | Own          | Own           | Own       | Own              |
| BYOS deployment                      | Required | Required     | Later         | Required  | Own              |
| Durable Object deployment            | Required | Own          |               | Own       | Own              |
| Global read edge                     | Required | Required     | Required      |           | Own              |
| Pinned multi-repository manifest     | Required |              |               |           |                  |
| Conformance lab                      | Required | Later        | Later         | Required  | Later            |

## 2. Common baselines

Measure each candidate against the fastest relevant supported incumbent, not a
deliberately weak configuration:

- current `wasm-git` OPFS auto-selected variant for browser work;
- stock Git partial clone plus sparse checkout for selective workflows;
- GitHub/GitLab commit APIs for forge-bound structured writes;
- a local bare repository and stock Smart HTTP for server throughput;
- forge-native backup for a single-provider backup comparison;
- Git Bundle URI or an existing CDN path for distribution.

Pin exact versions, browser profile, origin, network shaping, CPU allocation,
and cache state. Report cold and warm results separately.

## 3. Publication fault model

At minimum, inject a crash or deterministic error at each cut:

1. before the first immutable write;
2. during object or pack write;
3. after close but before hash/read-back verification;
4. after verification but before metadata admission;
5. while validating connectivity or policy;
6. immediately before the metadata transaction;
7. after metadata commit but before the caller receives a response;
8. during cleanup, compaction, or garbage collection;
9. after a stale writer loses its lease/fence but continues running.

After restart, an atomic or typed transaction must be exactly old or fully new.
An ordinary receive-pack operation may instead expose exactly the subset whose
per-ref status was successful; rejected refs must remain unchanged. Unreachable
immutable bytes are acceptable and must be collectible. A reachable partial
graph, a ref outcome that disagrees with the reported statuses, or a duplicated
publication is not.

## 4. Concurrency schedules

Use process/Worker/browser isolation rather than Promise-only concurrency.
Required schedules include:

- same expected branch tip, two writers, exactly one winner;
- disjoint refs in one requested transaction;
- direct and symbolic ref changes together;
- writer expiry followed by a higher fencing generation;
- ambiguous response followed by exact idempotent retry when a typed/stable-key
  API claims it; otherwise stock Git ref inspection and convergence;
- same idempotency key with a different digest, which must reject when that API
  is claimed;
- readers pinned before, during, and after repack/publication;
- multi-repository readers during a release-manifest change when applicable.

Counts are layered:

- **End-to-end process/browser/network tests:** at least 20 kills at each
  supported publication cut, 100 same-fence races, and 100 ambiguous-response
  retries during a two-week spike.
- **Fast metadata/model tests:** at least 1,000 deterministic publications
  during a two-week spike when the direction claims a metadata authority.
  A 10,000-seed randomized campaign is a later continuation/production gate
  only when the direction explicitly adopts it.
- **Non-publication products:** backup, edge, and manifest experiments use the
  counts in their own documents rather than inventing meaningless ref races.

Every applicable schedule must produce zero lost or torn state transitions. A
zero-duplicate logical-replay claim applies only to a typed/stable-key API; an
ordinary receive-pack test instead covers one admitted request and current-ref
convergence, and its original outcome may be indeterminate after intervening
ABA movement. A direction may set a larger count, but it must not describe
model-level iterations as full process or network failures. These counts define
acceptance depth; they are not mathematical proof or a statistical confidence
claim. The invariants and independent oracles determine correctness.

## 5. Resource and transport accounting

Report at least:

- time to first requested file/object;
- wall time and active CPU time;
- peak process/WASM/Worker memory;
- bytes downloaded and uploaded by class;
- local persistent bytes and unreachable bytes;
- number and size of backend operations;
- p50, p95, and p99 latency;
- retry count and recovery duration.

For streaming claims, enforce a fixed memory ceiling below the largest pack or
blob. A test that succeeds only by buffering the entire response is not a
streaming result.

## 6. Interoperability oracle

Where a direction claims standard Git compatibility, its output must be read
by an independently installed stock Git:

```sh
git clone <candidate-url> oracle
git -C oracle fsck --full --strict
git -C oracle rev-list --objects --all
git -C oracle show-ref --head
```

Round-trip at least clone, fetch, fast-forward push, rejected non-fast-forward,
force-with-lease, tags, symbolic/detached HEAD as applicable, and atomic
multi-ref push when claimed. Compare raw blob/tree/commit/tag object IDs, not
only checked-out file contents.

## 7. Security and isolation checks

The suite must bound untrusted pack/object input, paths, ref names, decompressed
sizes, delta depth, CPU, and memory. Backend credentials must never cross into
browser clients or logs. Multi-tenant/server experiments additionally require:

- tenant-qualified object and metadata keys;
- authorization before repository routing;
- no cross-repository object existence oracle unless explicitly designed;
- redacted structured errors;
- quota and abuse tests;
- restore and key-rotation procedures.

## 8. Evidence format

Every spike should produce one machine-readable result containing:

- source and dependency revisions;
- corpus seed and hashes;
- environment and limits;
- exact command/API workload;
- baseline and candidate measurements;
- all injected cuts and schedules;
- oracle output digests;
- pass/fail against every predeclared gate.

Raw logs are evidence, not the decision. The decision document must explicitly
map each gate to the recorded result and state `GO`, `ITERATE ONCE`, or `STOP`.

---

[Strategy index](README.md) · [Recommended sequencing](10-recommendation.md)
