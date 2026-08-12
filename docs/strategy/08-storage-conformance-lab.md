# Non-product fallback: Git storage conformance lab

<!-- markdownlint-disable MD013 -->

Status: low-risk, non-product fallback.

## Decision

If no product direction passes its user and performance gates, preserve the
failure model as a small conformance project and archive the runtime. The lab
would compare Git engines and storage adapters under browser/process crashes,
multi-context races, ambiguous responses, and canonical Git verification.

This is useful engineering infrastructure and a possible source of upstream
contributions. It is not a venture-scale product, a reason to maintain two
WASM modules, or a substitute for choosing `wasm-git`/stock Git.

## User and job

The users are maintainers of browser Git engines, custom libgit2/go-git/JGit
storage backends, offline web applications, and object-store Git services.
Their job is:

> Reproduce a storage failure with a seed, determine whether state after
> restart is old, new, or invalid, compare implementations under the same
> schedule, and verify output with an independent Git oracle.

The output is evidence: a trace, durable-state digest, oracle result, and
resource measurements. It is not a repository editor.

## Why wasm-git alone does not solve it

`wasm-git` has valuable Node and browser tests for its command surface, OPFS
variants, persistence reload, and runtime loader. Those tests correctly serve
its own implementation. They do not define a vendor-neutral contract for:

- expected-ref compare-and-publish;
- multi-ref atomicity across a storage backend;
- exact idempotent replay after response loss;
- process-independent multi-context schedules;
- every immutable-byte/metadata publication cut;
- comparative resource and backend-operation accounting.

The lab would test `wasm-git`, not replace it. Where an implementation does not
claim a capability, the report says `unsupported`; it must not turn one
project's private API into the definition of Git correctness.

## Scope and architecture

```text
scenario JSON + corpus seed + schedule seed
                  |
                  v
        deterministic orchestrator
          /        |         \
         v         v          v
 current split   wasm-git    future backend
 backend adapter OPFS adapter adapters
         \         |          /
                  v
       durable-state/export capture
                  |
       +----------+-----------+
       |                      |
       v                      v
semantic oracle         resource recorder
old/new/invalid         bytes, memory, I/O
       |
       v
independent stock Git: object IDs + strict fsck
```

### Two layers, not one fake universal API

The suite separates:

1. **Git interoperability scenarios:** init/clone, write files or objects,
   commit, refs, reopen, export/fetch, and canonical verification. Most engines
   can participate.
2. **Storage-publication scenarios:** expected generation/ref, batched ref
   mutation, publication fence, receipt replay, and internal crash cuts. Only
   adapters claiming those capabilities participate.

This distinction prevents the current prototype's metadata API from becoming
an arbitrary requirement for `wasm-git` or stock Git.

### Driver contract

Each adapter declares capabilities and supplies only the operations needed by
the chosen scenarios:

- create/reset and open/reopen in a fresh process or browser context;
- perform a named Git or publication operation;
- arm a supported deterministic failure cut;
- terminate the owning process/Worker without a graceful close;
- inspect refs and implementation-neutral durable artifacts after restart;
- export or expose a repository to stock Git;
- report bytes, backend calls, wall/CPU time, and peak memory where available.

The orchestrator owns schedules, seeds, timeouts, and expected outcomes. Test
results use a versioned JSON schema and record exact engine/browser revisions.

### Failure oracle

After every restart, a publication is:

- **old:** no new ref reaches any new object;
- **new:** the complete requested ref set reaches a complete verified graph;
- **invalid:** a torn ref set, reachable missing/corrupt object, duplicate
  publication, wrong receipt, silent lost update, or unrecoverable repository.

Unreachable immutable bytes are measured as leakage, not corruption. A later
GC scenario may decide whether they are eventually reclaimed.

For POSIX/OPFS implementations whose internal write cuts are not exposed,
process termination at command boundaries is the honest initial coverage. The
lab must not claim mid-rename or mid-flush testing unless a small, explicit
instrumentation hook actually creates that cut.

## Reuse and throwaway

| Reuse nearly intact                         | Extract/generalize                                   | Throw away                                  |
| ------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| Metadata CAS/idempotency unit tests         | Backend operations into a capability-declared driver | Demo product UI                             |
| Browser reload and separate-process harness | Fault names into a stable scenario vocabulary        | Fixed proof commit as the only workload     |
| Race schedules and exact receipt assertions | Deterministic corpus generation                      | Go-WASM/Rust-WASM as mandatory dependencies |
| Git object ID comparisons and strict fsck   | Trace and machine-readable evidence format           | OpenDAL/OPFS as privileged target           |
| Required-object publication cuts            | Resource/backend-operation instrumentation           | Claims of a general Git client              |

The repository already contains the most expensive conceptual assets: real
process separation, persisted restart evidence, deterministic stale-writer
conflicts, and an external Git oracle. Extraction should reduce code and
dependencies.

## Competitive baseline

Do not duplicate broad correctness suites:

- Git's own [`t/` test framework](https://github.com/git/git/blob/master/t/README)
  is the authoritative behavioral baseline for stock Git.
- [`libgit2`](https://github.com/libgit2/libgit2) has a substantial unit and
  integration suite for the library beneath `wasm-git`.
- [`wasm-git`](https://github.com/petersalomonsen/wasm-git) tests its Node,
  browser, async, OPFS, non-isolated, and loader variants.
- Browser filesystem semantics belong in
  [Web Platform Tests](https://github.com/web-platform-tests/wpt/tree/master/fs)
  when the finding is a browser standards bug.

The lab earns a place only by making cross-engine failure schedules,
crash/restart state, transactional-storage claims, and the independent Git
oracle easier to reproduce than they are in each project separately. Findings
should be minimized and sent upstream rather than accumulated as a competing
fork.

## Two-week spike

### Days 1-3: scenario and evidence format

- Define the capability manifest, scenario JSON, trace JSON, and old/new/
  invalid oracle.
- Port the current deterministic commit, same-fence race, response-loss retry,
  altered-digest retry, restart, and strict-fsck cases without changing their
  expected semantics.
- Add one deliberately faulty in-memory adapter that publishes metadata before
  bytes; the lab must detect it.

### Days 4-7: two real adapters

- Adapter A: the current OPFS-object/IndexedDB-metadata implementation.
- Adapter B: pinned upstream `wasm-git` using its supported OPFS auto-selected
  variant, with ordinary command/reload coverage and capability gaps reported
  explicitly.
- Add a third comparison only if it is trivial: `wasm-git` mutations wrapped
  by one origin-wide Web Lock. This tests whether simple serialization removes
  enough multi-context failures to make a custom backend unnecessary.

### Days 8-10: adversarial schedules and reproducibility

- Run two independent browser contexts against one origin and repository.
- Terminate Workers/processes at every supported cut and immediately reopen.
- Run the small correctness corpus plus a ref-heavy corpus.
- Export survivors to a separately installed stock Git and run strict fsck.
- Produce one HTML summary from the machine-readable results, but keep JSON
  and raw traces authoritative.
- Ask one contributor who did not write an adapter to reproduce a failing seed
  using one documented command.

Day 10 ends with a technical `GO`, `ITERATE ONCE`, or `STOP` decision. A near
miss may receive one separately approved, bounded fix to remove an
adapter-specific assumption or minimize one real upstream bug. Technical `GO`
only opens a 30-day external-value window; it does not establish a continuing
project.

## Graduation metrics

| Gate           | Required result                                                                                  |
| -------------- | ------------------------------------------------------------------------------------------------ |
| Independence   | At least two real engines/storage layouts run through the same interoperability scenarios        |
| Sensitivity    | Every seeded faulty implementation is detected at the intended cut                               |
| Specificity    | Known-good reruns produce zero flaky/false failures across 100 repetitions                       |
| Determinism    | A reported seed reproduces the same schedule and durable-state digest 100/100 times              |
| Isolation      | Races use separate Workers/processes/browser contexts, not only concurrent Promises              |
| Oracle         | Every valid survivor has matching object/ref digests and passes stock `git fsck --full --strict` |
| CI cost        | The required small suite completes in under 30 minutes on ordinary CI hardware                   |
| Adapter cost   | A maintainer can add a capability-limited adapter without forking the orchestrator               |
| External value | Within 30 days, one minimized finding is accepted upstream or one maintainer adopts a scenario   |

The first eight gates determine whether the two-week extraction technically
worked. The external-value gate is a separately dated continuation decision and
determines whether the lab lives beyond 30 days. Passing internal tests alone
demonstrates only that the extraction worked.

## Fatal risks and kill gates

Stop or archive the lab when:

- meaningful crash cuts require a large invasive fork of every target;
- filesystem and engine semantics are too different for comparisons to mean
  more than a support matrix;
- schedules cannot be replayed reliably across browser runs;
- the harness reports success without an independent Git oracle;
- maintenance tracks browser, Emscripten, libgit2, go-git, and object-store
  changes with no upstream users;
- the project becomes a dashboard or hosted testing service before external
  adoption;
- existing upstream suites accept the useful cases directly, making the
  separate lab redundant.

## Verdict

**GO only as a bounded fallback and upstream vehicle; NO-GO as the product.**
If the lab misses its two-week technical gates, preserve a static test report
and archive the code. If those gates pass, open the separately dated 30-day
external-value window. Keep the smallest engine-neutral corpus only when an
upstream project accepts a minimized finding or an external maintainer adopts a
scenario during that window; otherwise archive the live lab after day 30.

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
