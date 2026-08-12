import assert from "node:assert/strict";
import test from "node:test";

import {
  blobPreview,
  decodeObjectBytes,
  decodeRepositoryTree,
  objectTypeForMode,
  parseCommitTreeOid,
  parseTreeEntries,
} from "./git-object-view.js";

const OIDS = Object.freeze({
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  blob: "3".repeat(40),
  childTree: "4".repeat(40),
  childBlob: "5".repeat(40),
});

function object(type, oid, bytes) {
  return { type, oid, base64: Buffer.from(bytes).toString("base64") };
}

function treeEntry(mode, name, oid) {
  return Buffer.concat([
    Buffer.from(`${mode} ${name}\0`, "utf8"),
    Buffer.from(oid, "hex"),
  ]);
}

function repository(objects, resolvedHeadOid = OIDS.commit) {
  return { resolvedHeadOid, objects };
}

test("decodes a nested canonical commit tree without decoding its message", () => {
  const commit = Buffer.concat([
    Buffer.from(`tree ${OIDS.tree}\nauthor A <a@example.test> 0 +0000\n\n`),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`\ntree ${"f".repeat(40)}\n`),
  ]);
  const decoded = decodeRepositoryTree(
    repository([
      object("commit", OIDS.commit, commit),
      object(
        "tree",
        OIDS.tree,
        Buffer.concat([
          treeEntry("40000", "docs", OIDS.childTree),
          treeEntry("100644", "README.md", OIDS.blob),
        ]),
      ),
      object(
        "tree",
        OIDS.childTree,
        treeEntry("100755", "run.sh", OIDS.childBlob),
      ),
      object("blob", OIDS.blob, "hello\n"),
      object("blob", OIDS.childBlob, "#!/bin/sh\n"),
    ]),
  );
  assert.equal(decoded.rootTreeOid, OIDS.tree);
  assert.deepEqual(
    decoded.entries.map(({ mode, path, oid, type, kind }) => ({
      mode,
      path,
      oid,
      type,
      kind,
    })),
    [
      {
        mode: "40000",
        path: "docs",
        oid: OIDS.childTree,
        type: "tree",
        kind: "directory",
      },
      {
        mode: "100755",
        path: "docs/run.sh",
        oid: OIDS.childBlob,
        type: "blob",
        kind: "executable",
      },
      {
        mode: "100644",
        path: "README.md",
        oid: OIDS.blob,
        type: "blob",
        kind: "file",
      },
    ],
  );
});

test("rejects malformed object and commit encodings", () => {
  assert.throws(
    () => decodeObjectBytes({ base64: "%%%=" }),
    /canonical base64/,
  );
  assert.throws(
    () =>
      parseCommitTreeOid(
        object(
          "commit",
          OIDS.commit,
          `author A <a@example.test> 0 +0000\n\ntree ${OIDS.tree}\n`,
        ),
      ),
    /root tree header/,
  );
  assert.throws(
    () => parseCommitTreeOid(object("commit", OIDS.commit, "no newline")),
    /no header line/,
  );
});

test("accepts only the supported canonical tree modes", () => {
  for (const [mode, type] of [
    ["40000", "tree"],
    ["100644", "blob"],
    ["100664", "blob"],
    ["100755", "blob"],
    ["120000", "blob"],
    ["160000", "commit"],
  ]) {
    assert.equal(objectTypeForMode(mode), type);
  }
  assert.throws(() => objectTypeForMode("100600"), /unsupported mode/);
  assert.throws(
    () =>
      parseTreeEntries(
        object("tree", OIDS.tree, treeEntry("100600", "file", OIDS.blob)),
      ),
    /unsupported mode/,
  );
  assert.throws(
    () =>
      parseTreeEntries(
        object("tree", OIDS.tree, treeEntry("100644", "a/b", OIDS.blob)),
      ),
    /invalid name/,
  );
  assert.throws(
    () =>
      parseTreeEntries(
        object("tree", OIDS.tree, treeEntry("100644", "..", OIDS.blob)),
      ),
    /invalid name/,
  );
  assert.throws(
    () =>
      parseTreeEntries(
        object(
          "tree",
          OIDS.tree,
          treeEntry("100644", "file", OIDS.blob).subarray(0, -1),
        ),
      ),
    /truncated entry/,
  );
});

test("fails closed on missing, mismatched, duplicate, and cyclic objects", () => {
  const commit = object(
    "commit",
    OIDS.commit,
    `tree ${OIDS.tree}\n\nmessage\n`,
  );
  const root = object(
    "tree",
    OIDS.tree,
    treeEntry("100644", "file", OIDS.blob),
  );
  assert.throws(
    () => decodeRepositoryTree(repository([commit, root])),
    new RegExp(`Missing blob object ${OIDS.blob}`),
  );
  assert.throws(
    () =>
      decodeRepositoryTree(
        repository([commit, root, object("tree", OIDS.blob, "")]),
      ),
    /Missing blob object/,
  );
  assert.throws(
    () =>
      decodeRepositoryTree(
        repository([
          commit,
          root,
          object("blob", OIDS.blob, "a"),
          object("blob", OIDS.blob, "b"),
        ]),
      ),
    /Duplicate object/,
  );
  const cycle = object(
    "tree",
    OIDS.tree,
    treeEntry("40000", "again", OIDS.tree),
  );
  assert.throws(
    () => decodeRepositoryTree(repository([commit, cycle])),
    /cycle/,
  );
});

test("previews bounded clean UTF-8 and classifies unsafe payloads", () => {
  assert.deepEqual(blobPreview(object("blob", OIDS.blob, "hello\nworld\n")), {
    kind: "text",
    text: "hello\nworld\n",
    byteLength: 12,
  });
  assert.deepEqual(blobPreview(object("blob", OIDS.blob, "")), {
    kind: "text",
    text: "Empty file",
    byteLength: 0,
  });
  assert.deepEqual(blobPreview(object("blob", OIDS.blob, Buffer.from([0]))), {
    kind: "binary",
    text: "Binary content · 1 bytes",
  });
  assert.deepEqual(
    blobPreview(object("blob", OIDS.blob, Buffer.from([0xff]))),
    { kind: "binary", text: "Binary content · 1 bytes" },
  );
  const large = object("blob", OIDS.blob, Buffer.alloc(4_097, 0x61));
  assert.deepEqual(blobPreview(large), {
    kind: "omitted",
    text: "Preview omitted · 4097 bytes",
  });
});
