# Browser transactional Git metadata prototype

`git-metadata-store.js` installs the Promise API consumed by Go WASM:

```js
globalThis.__gitMetadataStore.snapshot(repoId); // Promise<State>
globalThis.__gitMetadataStore.initialize(repoId, initial); // Promise<State>
globalThis.__gitMetadataStore.commit(repoId, mutation); // Promise<CommitResult>
globalThis.__gitMetadataStore.reset(repoId); // Promise<{repoId, deleted}>
```

`initialize` is create-only: it rejects an existing repository with
`REPOSITORY_EXISTS`, creates a new opaque `generation`, and sets `revision` to zero.
`reset` is explicit destructive deletion included for this deterministic test
prototype. A later initialize gets a fresh generation, preventing ABA reuse.

## State and mutation contract

```js
State = {
  repoId: string,
  generation: string,
  revision: number,
  refs: { [refName]: oid },
  head: { kind: "symbolic", target: refName } |
        { kind: "detached", oid },
  config: JSONValue,
  shallow: oid[],
}

Mutation = {
  idempotencyKey: string,
  digest: string,
  expectedGeneration: string,
  expectedRevision: number,
  expectedRefs: { [refName]: oid | null }, // null means absent
  updates: {
    refs?: { [refName]: oid | null },       // null deletes
    head?: State["head"],
    config?: JSONValue,
    shallow?: oid[],
  },
  requiredObjects: oid[],
  faultAt?: "beforeObjectReady" | "afterObjectReady" |
            "beforeMetadataCommit" | "afterMetadataCommit", // tests only
}

CommitResult = {
  repoId: string,
  generation: string,
  previousRevision: number,
  revision: number,
  state: State,
}
```

Repository IDs match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. This P0 contract
accepts only lowercase 40-hex SHA-1 object IDs. Symbolic HEAD and ref keys must be
minimally valid `refs/*` names, and a resulting ref namespace with a directory/file
collision (for example, both `refs/heads/a` and `refs/heads/a/b`) is rejected.

Before opening the metadata transaction, `commit` awaits the path-only object API
`globalThis.__gitObjectStore.exists("repos/" + repoId + "/objects/" + oid)` for
every required immutable object. It then uses one IndexedDB read/write transaction over the repository row
and idempotency receipt row. The transaction checks the idempotency key and digest,
generation, revision, and every expected old ref before publishing all ref, HEAD,
config, and shallow updates together.

The same idempotency key and digest returns the exact receipt-stored result without
advancing the revision. Reusing a key with another digest rejects. The caller owns
the digest calculation; `faultAt` is test control and is not part of the logical
mutation digest. A fault after metadata commit rejects with `details.committed=true`,
so retrying the same key and digest recovers the committed result.

Promises reject with `GitMetadataError`. `code` and `details` are enumerable for a
`syscall/js` bridge. Stable conflict codes are `GENERATION_CONFLICT`,
`REVISION_CONFLICT`, `REF_CONFLICT`, `IDEMPOTENCY_KEY_REUSED`, and
`OBJECT_NOT_READY`.

## Run the real-browser contract

```sh
node web/run-browser-tests.mjs
```

The runner serves the ES modules on localhost and uses an installed headless
Chromium. Set `CHROMIUM_PATH` if it is not in the Playwright browser cache. The
test page has no product UI; its DOM is only the machine-readable test result.
It proves two concurrent IndexedDB connections produce exactly one old-OID CAS
winner, all four fault boundaries, missing-object fencing, generation ABA fencing,
exact ambiguous idempotent retry, and metadata plus receipt persistence across a
real page reload and a new IndexedDB connection.
