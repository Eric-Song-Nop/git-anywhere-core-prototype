# Core storage prototype contract

This repository is deliberately limited to a bare Git runtime and its durable
storage boundary.

```text
go-git v5.19.2 (Go WASM)
  ├─ immutable encoded Git objects
  │    └─ Promise bridge → OpenDAL 0.58.1 (Rust WASM) → OPFS
  └─ mutable repository metadata
       └─ Promise bridge → one IndexedDB read/write transaction
            refs, symbolic HEAD, config, shallow set, revision, idempotency
```

## Publication rule

Objects are written and hash-verified before a metadata transaction may make a
ref reachable. The mutation first verifies that every required object is
readable. This check is safe outside IndexedDB only because P0 objects are
immutable and never deleted. It then checks all of these conditions in one
IndexedDB read/write transaction:

1. its idempotency key has not been reused with a different digest;
2. the opaque repository generation and integer revision both equal the
   caller's snapshot (generation prevents ABA after reset/reinitialize);
3. every expected ref still has the exact expected direct or symbolic value;
4. all requested ref/HEAD/config/shallow changes are applied together.

A crash before the metadata commit can leave only unreachable immutable
objects. A crash after the commit but before the caller sees the result is
recovered by retrying the same idempotency key and digest.

## Explicit prototype limits

- SHA-1 object format only, matching go-git v5.
- Bare repositories only: no index, worktree, checkout, hooks, submodules, or
  linked worktrees.
- One browser worker owns a repository mutation queue. IndexedDB CAS still
  rejects stale writers and makes multi-ref changes indivisible.
- OpenDAL OPFS is used only for immutable object bytes. It is not treated as a
  ref database and its lack of rename/conditional-CAS is intentional here.
- Pack streaming, fetch/push, GC/repack, reflogs, SHA-256 repositories, and a
  server metadata implementation are follow-on work.
