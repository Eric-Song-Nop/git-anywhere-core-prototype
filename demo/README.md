# Storage Lab demo

This is a deliberately small, no-framework UI over the existing browser Git
core. It does not duplicate storage logic in the page: one dedicated Worker
loads go-git Go-WASM, the OpenDAL Rust-WASM OPFS object facade, and the
IndexedDB metadata authority.

Build both ignored WASM outputs, then start the no-dependency demo server:

```sh
./rust-opendal/scripts/build.sh
./go-git/scripts/build.sh
node demo/serve.mjs
```

Open <http://127.0.0.1:4173/demo/>. The page can:

- initialize or reopen a named bare repository;
- publish the deterministic `proof.txt` blob/tree/commit through `main`;
- decode the published commit and tree into a logical
  `proof.txt → blob OID` file view without pretending a worktree exists;
- race two writers against one explicit generation/revision/ref fence and
  display the one-winner/one-conflict result;
- reload the page and Worker, then reopen the same OPFS + IndexedDB state;
- reset only the selected demo repository's mutable metadata. Immutable object
  bytes remain in OPFS and can be reused after reinitialization.

The reset path is test/demo-only. The UI proves the P0 storage contract; it
does not add clone/fetch/push, packs, worktrees, or a server authority.

Run the deterministic browser acceptance flow after building the two WASM
modules:

```sh
node demo/run-browser-tests.mjs
```

It drives a fresh Chromium profile through revision 0 initialization,
revision 1 publication, a revision 2 one-winner/one-conflict race, exact
page-and-Worker reload, responsive layout checks, and metadata-only reset.
The stronger integration harness separately proves persistence across two
fully distinct Chromium processes.
