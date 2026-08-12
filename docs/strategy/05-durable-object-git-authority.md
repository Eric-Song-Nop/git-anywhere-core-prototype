# Deployment profile: Durable Object Git authority

<!-- markdownlint-disable MD013 -->

Status: conditional Cloudflare deployment research for a transactional Git
authority, not a recommendation to deploy the current browser prototype.

## Decision

Run this spike only when a design partner specifically needs a serverless,
globally addressable Git authority on Cloudflare. It is not a way to make the
current browser runtime more valuable, and it is not a drop-in deployment of
`wasm-git`.

The defensible product is one coordination object per repository:

- a Durable Object and its SQLite database serialize policy and ref changes;
- R2 holds immutable packs and other large object bytes;
- standard Git Smart HTTP remains the client contract;
- browser clients use `wasm-git` rather than a new Git implementation.

This is a deployment profile of the new transactional Git authority product.
If a conventional Git service or a container running stock Git meets the same
job, stop and use it.

## User and job

The user is a SaaS or platform team that wants to create many small or medium
Git repositories without operating a mounted-filesystem repository fleet.
Their job is:

> Accept ordinary `git clone`, `fetch`, and `push`; serialize mutations for
> each repository; recover unambiguously after failure; and keep large bytes in
> object storage.

Before implementation, one named design partner must state why a conventional
Git service or Cloudflare Container is unacceptable, name its Cloudflare plan,
repository/push-size distribution, request rate, required Git capabilities, and
acceptable platform lock-in and cost. Without that evidence, this profile stays
`STOP` even if a small demo is technically possible.

The useful outcome is operational: deterministic per-repository routing and a
durable, single-writer metadata authority. "Git in WebAssembly" is not the
outcome.

## Why wasm-git alone does not solve it

[`wasm-git`](https://github.com/petersalomonsen/wasm-git) is a libgit2-based
client runtime. It gives a browser a local repository and real Git commands;
it does not provide a multi-tenant remote authority, server authorization,
quota enforcement, pack retention, or a globally routable Smart HTTP service.

Its browser build also cannot simply be placed inside a Worker. Cloudflare
Workers do not support Web Workers or WebAssembly threads, require a
precompiled WebAssembly module import, and prohibit buffer compilation and
`WebAssembly.instantiateStreaming`. The Workers file-system APIs expose an
in-memory virtual filesystem, not browser-persistent OPFS. See Cloudflare's
[WebAssembly runtime](https://developers.cloudflare.com/workers/runtime-apis/webassembly/),
[supported web standards](https://developers.cloudflare.com/workers/runtime-apis/web-standards/),
and [virtual filesystem](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)
documentation.

`wasm-git` should still be the browser client in this option. It and the
authority are complements.

## Proposed architecture

```text
native Git / wasm-git
        |
        | Git Smart HTTP
        v
Worker: authenticate, authorize, route tenant/repository
        |
        v
one Durable Object per repository
  SQLite metadata authority
    - repository generation and revision
    - direct and symbolic refs
    - expected-old values / force-with-lease state
    - push admission and policy result
    - immutable pack manifests
    - typed-API idempotency receipts and cleanup work
        |
        | immutable reads and writes
        v
R2 immutable byte plane
  - staged incoming packs
  - admitted immutable packs and indexes
  - optional loose objects or derived indexes
```

The repository is the coordination atom. A single global Durable Object would
be a bottleneck and would give unrelated repositories one failure domain.
Deterministic routing must include tenant identity as well as repository
identity.

### SQLite is the authority, not the object store

Durable Object SQLite should contain small control records. Cloudflare limits
a SQLite string, BLOB, or row to 2 MB and a paid SQLite-backed Durable Object
to 10 GB. Those limits alone rule out storing arbitrary Git blobs or packs in
rows. A Durable Object is also single-threaded and has a soft per-object
throughput limit. See the current [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/).

R2 is appropriate for immutable bytes because it provides globally strong
read-after-write consistency, ranged reads, streaming bodies, and conditional
writes. See the [R2 consistency model](https://developers.cloudflare.com/r2/reference/consistency/)
and [Workers R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).

The placement rule is strict:

| State                            | System of record | Reason                                                            |
| -------------------------------- | ---------------- | ----------------------------------------------------------------- |
| Refs, HEAD, generation, revision | DO SQLite        | Must change under one serialized policy decision                  |
| Typed-API receipt and digest     | DO SQLite        | Resolves response loss only when the caller supplies a stable key |
| Pack/object admission manifest   | DO SQLite        | Defines which immutable bytes are reachable                       |
| Pack, index, large blob bytes    | R2               | Streamable, range-readable, and not subject to SQLite row limits  |
| Hot decoded indexes              | Memory/cache     | Rebuildable; never authoritative                                  |
| Unadmitted/staged pack           | R2               | May survive a crash but must remain unreachable                   |

### Publication is a protocol, not a cross-service transaction

SQLite and R2 cannot participate in one atomic transaction. Correctness comes
from ordering and reachability:

1. Authenticate and validate the advertised old ref values.
2. Stream the incoming pack to a unique staging key in R2. Do not buffer the
   whole request in the isolate.
3. Validate the pack checksum, object graph connectivity, ref names, quotas,
   and policy while no new ref can reach the staged bytes.
4. Make every admitted immutable pack/index key readable and verify it before
   publication.
5. Re-read the repository generation, revision, and expected refs in the
   Durable Object. In one SQLite commit, record the pack manifest and update
   exactly the refs whose final receive-pack status is successful. Store an
   exact receipt only when a typed API or explicit stable push option supplied
   a durable idempotency key.
6. Return receive-pack per-ref status. After a lost response, an ordinary Git
   client inspects refs and converges from observed state; a typed caller can
   replay its stored receipt. Reusing a typed key with a different digest
   rejects.
7. Reclaim staged or admitted-but-unreferenced bytes only after a conservative
   reachability and grace-period check.

A crash before step 5 may leak unreachable immutable bytes. A crash after step
5 may lose the response. Neither may expose a partial graph or ref state that
disagrees with the advertised per-ref statuses; an atomic request may never
expose a partially updated requested ref set.

Ordinary multi-ref receive-pack may report a successful subset and rejected
refs. The SQLite transaction publishes exactly the successful subset and its
manifest. When the client requests `git push --atomic`, any rejection aborts
the entire requested set. A stronger all-or-none-on-every-push policy is
allowed, but must be documented as server policy rather than stock Git behavior.

Ordinary Git Smart HTTP does not carry a universally stable idempotency key.
Never infer logical retry identity from a repeated request body. Exact receipt
replay is a separate typed-API guarantee; the stock Git correctness guarantee
is expected-old comparison plus observable ref convergence.

Do not hold a Durable Object-wide concurrency block across R2 I/O. External
I/O allows interleaving, so the final SQLite compare-and-publish step must
revalidate its fence after the R2 work.

### Smart HTTP is the highest technical risk

The server must implement the standard
[`gitprotocol-http`](https://git-scm.com/docs/gitprotocol-http) contract,
including upload-pack and receive-pack behavior, rather than inventing an
object-store protocol that requires a custom client. Push must preserve
quarantine, connectivity, expected-old, and requested multi-ref atomicity.
Stock Git defines `git push --atomic` as all requested refs updating or none;
see [`git-push`](https://git-scm.com/docs/git-push).

The current core has not proved this path:

- it deliberately omits fetch, push, pack streaming, object iteration,
  reflogs, GC/repack, and a server authority;
- its `Store` does not implement go-git's `PackfileWriter` and rejects whole
  object iteration;
- its object write path reads one decoded object fully into memory;
- go-git v5.19.2's server implementation contains an explicit
  [atomic-ref TODO](https://github.com/go-git/go-git/blob/v5.19.2/plumbing/transport/server/server.go)
  and applies receive-pack ref commands one by one.

Therefore the current transaction backend does not automatically make
go-git's Smart HTTP server atomic. The receive-pack integration itself would
need a bounded, reviewed adaptation.

## Reuse and throwaway

| Reuse                                      | Adapt                                                         | Throw away                                 |
| ------------------------------------------ | ------------------------------------------------------------- | ------------------------------------------ |
| Immutable-before-metadata publication rule | `MetadataMutation` into a SQLite schema and one batch publish | Browser IndexedDB implementation           |
| Generation, revision, expected-ref CAS     | Object facade into pack/index-aware R2 reads                  | OPFS and the Rust OpenDAL module           |
| Typed-API idempotency digest and receipt   | Fault harness to terminate an isolate/request                 | Demo UI and fixed proof commit API         |
| Required-object/read-back validation       | Canonical oracle into native Smart HTTP tests                 | Browser Worker ownership assumption        |
| Crash-cut and independent `git fsck` tests | Authentication, quota, GC, and observability                  | Go-WASM as a protected architecture choice |

OpenDAL is optional here. When only R2 is in scope, the platform binding is
simpler and exposes conditional and ranged operations directly.

## Competitive and standards baseline

The candidate must be tested against a correctness control, not only against
the current prototype:

1. **Stock Git in a container.** Cloudflare's
   [`Container` class](https://developers.cloudflare.com/containers/container-class/)
   is itself backed by a Durable Object and can run a normal Linux Git server.
   Its disk is ephemeral, so persistence still needs design, but it is the
   fastest control for protocol correctness and streaming behavior.
2. **A conventional bare repository with `git-http-backend`.** This is the
   latency, compatibility, quarantine, and atomic-push oracle.
3. **JGit DFS.** JGit 7.7.1 has an
   [internal DFS implementation framework](https://github.com/eclipse-jgit/jgit/tree/v7.7.1.202607240634-r/org.eclipse.jgit/src/org/eclipse/jgit/internal/storage/dfs)
   for repositories, object/ref databases, bundles, fsck, and compaction. It
   still requires concrete stores and a metadata catalog rather than acting as
   a drop-in backend. A Java service may be less novel and substantially safer.
4. **Existing Git hosting.** If the user only wants managed repositories,
   incumbent forges remain the real build-versus-buy baseline.

The pure Worker/DO implementation wins only if the serverless placement model
is required and it passes the same Git semantics within the runtime limits.

## Two-week spike

Time-box the work. Do not build a UI, SSH transport, hooks, multi-region
replication layer, or general GC.

### Days 1-3: shared server-engine and deployability gate

- Run the shared
  [server-engine viability gate](09-validation-program.md#0-server-engine-viability-gate):
  bounded upload-pack, receive-pack quarantine, and one atomic two-ref
  publication seam must pass before Cloudflare-specific storage work continues.
- Build the smallest viable server-engine artifact for `workerd` using a precompiled
  module import; do not reuse browser OPFS or Emscripten assumptions.
- Run `wrangler deploy --dry-run` and measure compressed size and startup.
- Prove a streaming request can write a 64 MiB pack to R2 without buffering
  it, then range-read it back.
- Record total isolate memory with a 16 MiB incompressible blob in the pack.

Cloudflare currently limits Workers to 128 MB per isolate, a 1-second startup,
and compressed bundles of 3 MB on Free or 10 MB on Paid. The current Go WASM
alone is 11,025,421 bytes raw and approximately 2.95 MB gzip, leaving no
credible Free-plan budget for the application. Use the paid limit as the spike
gate, not as an excuse to ignore startup or memory. See [Workers limits](https://developers.cloudflare.com/workers/platform/limits/).

### Days 4-7: one narrow Smart HTTP path

- Route one repository to one Durable Object.
- Implement clone/fetch of a preloaded branch and push of one new commit from
  stock Git.
- Store pack bytes in R2 and refs/manifests/typed receipts in SQLite.
- Fetch the pushed commit into a fresh stock Git checkout and run
  `git fsck --full --strict`.
- Run the identical workflow against the stock-Git container control.

The graduated experiment supports total receive-pack request bodies up to 64
MiB on every plan. Cloudflare's account-plan request-body caps are higher: 100
MB for Free/Pro, 200 MB for Business, and 500 MB by default for Enterprise. The
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/#request-and-response-limits)
are platform admission limits, not values that streaming can bypass.

On the selected design-partner plan, test a valid receive-pack request at 64
MiB, a request between 64 MiB and the Cloudflare cap, and a request above the
Cloudflare cap. The middle case is rejected by service policy and the last may
receive the platform's `413`; every rejection must leave refs/manifests
unchanged and staged bytes absent or collectible. A larger graduated limit
requires the same valid-pack, connectivity, memory, and failure suite at that
exact size; streaming alone is not evidence.

### Days 8-10: concurrency and failure

- Race two force-with-lease pushes from the same old tip; exactly one wins.
- Push two refs with `--atomic`; either both change or neither changes.
- Terminate at every R2/SQLite publication cut, including after R2 admission
  before SQLite and after SQLite before response.
- Retry the exact request and verify the exact receipt without another ref
  advancement through the typed API. Separately, lose a stock Git response,
  inspect refs, and converge from current state without blind body replay. If
  intervening ref movement returns to the old OID, the original stock-push
  outcome may remain indeterminate.
- Confirm that a different payload using the same idempotency key rejects.

Day 10 ends with a `GO`, `ITERATE ONCE`, or `STOP` decision. A near miss may
receive one separately approved, bounded measurement fix; it does not extend
the spike into broader product work.

## Graduation metrics

All gates are mandatory:

| Gate             | Required result                                                                                                                                                                                    |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployment       | Paid-plan bundle under 10 MB gzip and startup under 1 second                                                                                                                                       |
| Memory/streaming | 64 MiB pack accepted with peak isolate memory below 100 MB; no whole-pack buffer                                                                                                                   |
| Interoperability | Fresh stock Git clone/fetch/push succeeds and strict fsck passes                                                                                                                                   |
| Ref semantics    | force-with-lease conflict is correct; advertised `--atomic` is genuinely all-or-none                                                                                                               |
| Crash safety     | typed/atomic requests expose only old or new; ordinary pushes match their reported successful subset                                                                                               |
| Retry            | typed replay returns the stored result without another revision; stock Git inspects refs and converges from current state without blind body replay, while an ABA history may remain indeterminate |
| Body limits      | a valid 64 MiB receive-pack passes bounded-memory checks; service- and platform-limit rejections never change refs                                                                                 |
| Performance      | candidate/control p95 <= 2.0; warm no-op fetch <= 500 ms and accepted <=1 MiB push <= 3 s                                                                                                          |
| Isolation        | repository keys, auth decisions, quotas, and logs do not cross tenant boundaries                                                                                                                   |

Do not advertise `atomic`, protocol capabilities, or pack sizes that did not
pass their specific gate.

## Fatal risks and kill gates

Stop the direction if any of these is true after the spike:

- the engine cannot remain below the Worker size, startup, CPU, or memory
  limits while streaming realistic packs;
- receive-pack needs a broad private fork to provide quarantine, connectivity,
  force-with-lease, or atomic ref publication;
- a stock client cannot clone, push, and strictly verify the result;
- an R2/SQLite cut can make a ref reach missing bytes;
- hot repositories need more single-object throughput than the per-repository
  authority can provide;
- the partner's ordinary receive-pack bodies routinely exceed the selected
  Cloudflare account-plan cap or require a custom chunking client;
- the product needs SSH, hooks, filesystem semantics, or Git protocol features
  that make a containerized stock Git service simpler;
- no design partner values the Cloudflare/serverless placement enough to
  accept platform lock-in and paid-plan limits.

If the container control passes quickly and the pure Worker engine consumes
more than twice the integration effort, select the container or an existing
Git service. Do not preserve the Go-WASM core for sunk-cost reasons.

## Verdict

**Conditional GO for the two-week spike only; NO-GO for deploying the current
prototype as-is.** The Durable Object idea is valuable only as a remote Git
authority. SQLite controls reachability, R2 stores immutable packs, and Smart
HTTP compatibility is the existential gate. On the client, adopt `wasm-git`.
On the server, prefer canonical Git in a container unless the pure
Worker/SQLite/R2 design proves a measured operational advantage.

---

[Strategy index](README.md) · [Shared validation](09-validation-program.md) ·
[Recommended sequencing](10-recommendation.md)
