import "../wasm_exec.js";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { installGitCore } from "../loader.js";

const codedError = (code, message) => Object.assign(new Error(message), { code, details: {} });
const clone = (value) => structuredClone(value);

const objectValues = new Map();
globalThis.__gitObjectStore = {
  async put(path, bytes) {
    const value = Uint8Array.from(bytes);
    const prior = objectValues.get(path);
    if (prior && !Buffer.from(prior).equals(Buffer.from(value))) {
      throw codedError("ImmutableConflict", `different value at ${path}`);
    }
    objectValues.set(path, value);
    return value.byteLength;
  },
  async get(path) {
    const value = objectValues.get(path);
    if (!value) throw codedError("NotFound", `missing ${path}`);
    return Uint8Array.from(value);
  },
  async exists(path) {
    return objectValues.has(path);
  },
  async size(path) {
    const value = objectValues.get(path);
    if (!value) throw codedError("NotFound", `missing ${path}`);
    return value.byteLength;
  },
};

const states = new Map();
const receipts = new Map();
let generation = 0;
globalThis.__gitMetadataStore = {
  async snapshot(repoId) {
    const state = states.get(repoId);
    if (!state) throw codedError("REPOSITORY_NOT_FOUND", `missing ${repoId}`);
    return clone(state);
  },
  async initialize(repoId, initial) {
    if (states.has(repoId)) throw codedError("REPOSITORY_EXISTS", `exists ${repoId}`);
    const state = {
      repoId,
      generation: `node-generation-${++generation}`,
      revision: 0,
      refs: clone(initial.refs ?? {}),
      head: clone(initial.head ?? null),
      config: clone(initial.config ?? {}),
      shallow: clone(initial.shallow ?? []),
    };
    states.set(repoId, state);
    return clone(state);
  },
  async commit(repoId, mutation) {
    const receiptKey = `${repoId}/${mutation.idempotencyKey}`;
    const receipt = receipts.get(receiptKey);
    if (receipt) {
      if (receipt.digest !== mutation.digest) throw codedError("IDEMPOTENCY_KEY_REUSED", "digest changed");
      return clone(receipt.result);
    }
    const state = states.get(repoId);
    if (state.generation !== mutation.expectedGeneration) throw codedError("GENERATION_CONFLICT", "generation changed");
    if (state.revision !== mutation.expectedRevision) throw codedError("REVISION_CONFLICT", "revision changed");
    for (const [name, expected] of Object.entries(mutation.expectedRefs ?? {})) {
      if ((state.refs[name] ?? null) !== expected) throw codedError("REF_CONFLICT", `${name} changed`);
    }
    for (const oid of mutation.requiredObjects ?? []) {
      if (!(await globalThis.__gitObjectStore.exists(`repos/${repoId}/objects/${oid}`))) {
        throw codedError("OBJECT_NOT_READY", oid);
      }
    }
    const next = clone(state);
    for (const [name, oid] of Object.entries(mutation.updates?.refs ?? {})) {
      if (oid === null) delete next.refs[name];
      else next.refs[name] = oid;
    }
    if ("head" in (mutation.updates ?? {})) next.head = clone(mutation.updates.head);
    if ("config" in (mutation.updates ?? {})) next.config = clone(mutation.updates.config);
    if ("shallow" in (mutation.updates ?? {})) next.shallow = clone(mutation.updates.shallow);
    next.revision++;
    states.set(repoId, next);
    const result = {
      repoId,
      generation: next.generation,
      previousRevision: state.revision,
      revision: next.revision,
      state: clone(next),
    };
    receipts.set(receiptKey, { digest: mutation.digest, result });
    return clone(result);
  },
};

await installGitCore(await readFile(new URL("../git-core.wasm", import.meta.url)));

const initPromise = globalThis.__gitCore.init("node-smoke", { branch: "main" });
if (!(initPromise instanceof Promise)) throw new Error("init did not return a Promise immediately");
const initial = await initPromise;
const options = {
  branch: "main",
  idempotencyKey: "node-smoke:first-commit",
  expectedGeneration: initial.generation,
  expectedRevision: initial.revision,
  expectedBranchOid: null,
};
const first = await globalThis.__gitCore.createCommit("node-smoke", options);
const replay = await globalThis.__gitCore.createCommit("node-smoke", options);
if (JSON.stringify(first) !== JSON.stringify(replay)) throw new Error("ambiguous retry did not replay exact receipt");
if (states.get("node-smoke").revision !== 1) throw new Error("ambiguous retry advanced revision");

const state = await globalThis.__gitCore.readCommitState("node-smoke");
if (state.resolvedHeadOid !== first.commitOid || state.head?.target !== "refs/heads/main" || state.objects.length !== 3) {
  throw new Error("unexpected exported state");
}
for (const object of state.objects) {
  const payload = Buffer.from(object.base64, "base64");
  const oid = createHash("sha1")
    .update(`${object.type} ${payload.byteLength}\0`)
    .update(payload)
    .digest("hex");
  if (oid !== object.oid) throw new Error(`OID mismatch for ${object.oid}: ${oid}`);
}
console.log(JSON.stringify({ ok: true, commitOid: first.commitOid, revision: state.revision, objects: state.objects.length }));
process.exit(0);
