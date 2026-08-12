# Real-browser core integration

This harness runs the complete P0 browser storage stack in a dedicated Worker:

1. Rust-WASM OpenDAL stores immutable, envelope-encoded Git objects in OPFS.
2. IndexedDB transactionally owns refs, HEAD, config, shallow state, generations,
   revisions, and idempotency receipts.
3. Go-WASM/go-git initializes a bare repository and creates/reads real Git
   blob, tree, and commit objects.

`run-integration.mjs` keeps one localhost server alive while launching two
sequential, fully separate Chromium processes with the same temporary profile.
Phase 1 initializes a repository, races two commits against the same explicit
generation/revision/absent-ref fence, requires exactly one winner, and replays
that winner with the original fence and idempotency key. Phase 2 reopens the
same repository after the first Chromium process has exited. The runner
requires exact exported-state equality, feeds every raw payload into the local
canonical Git implementation, compares every OID, publishes refs/HEAD into a
   temporary bare repository, and runs `git fsck --full --strict`.

Build both WASM modules first, then run:

```sh
./rust-opendal/scripts/build.sh
./go-git/scripts/build.sh
node ./integration/run-integration.mjs
```

Set `CHROMIUM_PATH` only when an installed Playwright headless shell or standard
macOS Chromium application cannot be discovered automatically. The command
prints one machine-readable JSON object and exits nonzero on any failed
assertion. Temporary browser profiles and canonical Git repositories are
removed after the result is produced.
