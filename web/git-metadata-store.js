const DEFAULT_DATABASE_NAME = "git-anywhere-metadata-v1";
const DATABASE_VERSION = 1;
const REPOSITORIES_STORE = "repositories";
const RECEIPTS_STORE = "receipts";
const RECEIPTS_BY_REPOSITORY = "byRepository";
const REPOSITORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA1_PATTERN = /^[0-9a-f]{40}$/;

const FAULT_STAGES = new Set([
  "beforeObjectReady",
  "afterObjectReady",
  "beforeMetadataCommit",
  "afterMetadataCommit",
]);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export class GitMetadataError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "GitMetadataError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = {}) {
  throw new GitMetadataError(code, message, details);
}

function assertNonEmptyString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    fail("INVALID_ARGUMENT", `${field} must be a non-empty string`, { field });
  }
  return value;
}

function normalizeRepositoryId(value) {
  if (typeof value !== "string" || !REPOSITORY_ID_PATTERN.test(value)) {
    fail(
      "INVALID_ARGUMENT",
      "repoId must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
      { field: "repoId" },
    );
  }
  return value;
}

function normalizeOid(value, field) {
  if (typeof value !== "string" || !SHA1_PATTERN.test(value)) {
    fail("INVALID_ARGUMENT", `${field} must be a lowercase 40-hex SHA-1`, {
      field,
    });
  }
  return value;
}

function normalizeRefName(value, field) {
  assertNonEmptyString(value, field);
  const components = value.split("/");
  if (
    !value.startsWith("refs/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[\x00-\x20~^:?*[\\]/.test(value) ||
    components.some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".lock"),
    )
  ) {
    fail("INVALID_ARGUMENT", `${field} must be a minimally valid refs/* name`, {
      field,
    });
  }
  return value;
}

function assertNoDirectoryFileCollision(refs, field) {
  const names = Object.keys(refs).sort();
  const namesSet = new Set(names);
  for (const name of names) {
    const components = name.split("/");
    for (let index = 1; index < components.length; index += 1) {
      const prefix = components.slice(0, index).join("/");
      if (namesSet.has(prefix)) {
        fail("REF_DIRECTORY_FILE_CONFLICT", "Git refs have a D/F collision", {
          field,
          ref: name,
          prefix,
        });
      }
    }
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail("INVALID_ARGUMENT", `${field} must be a non-negative safe integer`, {
      field,
    });
  }
  return value;
}

function assertPlainObject(value, field) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    fail("INVALID_ARGUMENT", `${field} must be a plain object`, { field });
  }
  return value;
}

function cloneJson(value, field) {
  const ancestors = new Set();

  function clone(current, path) {
    if (
      current === null ||
      typeof current === "string" ||
      typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number" && Number.isFinite(current)) {
      return current;
    }
    if (Array.isArray(current)) {
      if (ancestors.has(current)) {
        fail("INVALID_ARGUMENT", `${field} must not contain cycles`, { field, path });
      }
      ancestors.add(current);
      const result = current.map((entry, index) => clone(entry, `${path}[${index}]`));
      ancestors.delete(current);
      return result;
    }
    if (
      current !== null &&
      typeof current === "object" &&
      Object.getPrototypeOf(current) === Object.prototype
    ) {
      if (ancestors.has(current)) {
        fail("INVALID_ARGUMENT", `${field} must not contain cycles`, { field, path });
      }
      ancestors.add(current);
      const result = {};
      for (const key of Object.keys(current).sort()) {
        result[key] = clone(current[key], `${path}.${key}`);
      }
      ancestors.delete(current);
      return result;
    }
    fail("INVALID_ARGUMENT", `${field} must be JSON-compatible`, { field, path });
  }

  return clone(value, field);
}

function cloneValue(value) {
  return structuredClone(value);
}

function normalizeRefs(value, field) {
  const input = assertPlainObject(value, field);
  const result = {};
  for (const name of Object.keys(input).sort()) {
    normalizeRefName(name, `${field} ref name`);
    result[name] = normalizeOid(input[name], `${field}.${name}`);
  }
  assertNoDirectoryFileCollision(result, field);
  return result;
}

function normalizeExpectedRefs(value) {
  const input = assertPlainObject(value, "mutation.expectedRefs");
  const result = {};
  for (const name of Object.keys(input).sort()) {
    normalizeRefName(name, "mutation.expectedRefs ref name");
    const expected = input[name];
    if (expected !== null) {
      normalizeOid(expected, `mutation.expectedRefs.${name}`);
    }
    result[name] = expected;
  }
  return result;
}

function normalizeRefUpdates(value) {
  const input = assertPlainObject(value, "mutation.updates.refs");
  const result = {};
  for (const name of Object.keys(input).sort()) {
    normalizeRefName(name, "mutation.updates.refs ref name");
    const next = input[name];
    if (next !== null) {
      normalizeOid(next, `mutation.updates.refs.${name}`);
    }
    result[name] = next;
  }
  return result;
}

function normalizeHead(value, field) {
  const head = assertPlainObject(value, field);
  if (head.kind === "symbolic") {
    return {
      kind: "symbolic",
      target: normalizeRefName(head.target, `${field}.target`),
    };
  }
  if (head.kind === "detached") {
    return {
      kind: "detached",
      oid: normalizeOid(head.oid, `${field}.oid`),
    };
  }
  fail("INVALID_ARGUMENT", `${field}.kind must be symbolic or detached`, {
    field: `${field}.kind`,
  });
}

function normalizeShallow(value, field) {
  if (!Array.isArray(value)) {
    fail("INVALID_ARGUMENT", `${field} must be an array`, { field });
  }
  return value.map((oid, index) =>
    normalizeOid(oid, `${field}[${index}]`),
  );
}

function normalizeInitial(repoId, initial, generation) {
  const value = assertPlainObject(initial ?? {}, "initial");
  return {
    repoId,
    generation,
    revision: 0,
    refs: normalizeRefs(value.refs ?? {}, "initial.refs"),
    head: normalizeHead(
      value.head ?? { kind: "symbolic", target: "refs/heads/main" },
      "initial.head",
    ),
    config: cloneJson(value.config ?? {}, "initial.config"),
    shallow: normalizeShallow(value.shallow ?? [], "initial.shallow"),
  };
}

function normalizeMutation(mutation) {
  const value = assertPlainObject(mutation, "mutation");
  const updates = assertPlainObject(value.updates, "mutation.updates");
  if (!Array.isArray(value.requiredObjects)) {
    fail("INVALID_ARGUMENT", "mutation.requiredObjects must be an array", {
      field: "mutation.requiredObjects",
    });
  }
  if (value.faultAt !== undefined && !FAULT_STAGES.has(value.faultAt)) {
    fail("INVALID_ARGUMENT", "mutation.faultAt is not a known fault stage", {
      field: "mutation.faultAt",
      value: value.faultAt,
    });
  }

  const normalizedUpdates = {};
  if (hasOwn(updates, "refs")) {
    normalizedUpdates.refs = normalizeRefUpdates(updates.refs);
  }
  if (hasOwn(updates, "head")) {
    normalizedUpdates.head = normalizeHead(updates.head, "mutation.updates.head");
  }
  if (hasOwn(updates, "config")) {
    normalizedUpdates.config = cloneJson(
      updates.config,
      "mutation.updates.config",
    );
  }
  if (hasOwn(updates, "shallow")) {
    normalizedUpdates.shallow = normalizeShallow(
      updates.shallow,
      "mutation.updates.shallow",
    );
  }

  return {
    idempotencyKey: assertNonEmptyString(
      value.idempotencyKey,
      "mutation.idempotencyKey",
    ),
    digest: assertNonEmptyString(value.digest, "mutation.digest"),
    expectedGeneration: assertNonEmptyString(
      value.expectedGeneration,
      "mutation.expectedGeneration",
    ),
    expectedRevision: assertNonNegativeInteger(
      value.expectedRevision,
      "mutation.expectedRevision",
    ),
    expectedRefs: normalizeExpectedRefs(value.expectedRefs),
    updates: normalizedUpdates,
    requiredObjects: value.requiredObjects.map((oid, index) =>
      normalizeOid(oid, `mutation.requiredObjects[${index}]`),
    ),
    faultAt: value.faultAt,
  };
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true,
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB request failed")),
      { once: true },
    );
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB transaction aborted")),
      { once: true },
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB transaction failed")),
      { once: true },
    );
  });
}

function deleteReceiptsForRepository(receiptsStore, repoId) {
  return new Promise((resolve, reject) => {
    const request = receiptsStore
      .index(RECEIPTS_BY_REPOSITORY)
      .openCursor(IDBKeyRange.only(repoId));
    request.addEventListener("success", () => {
      const cursor = request.result;
      if (cursor === null) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("Receipt cursor failed")),
      { once: true },
    );
  });
}

function mapStorageError(error, operation, repoId) {
  if (error instanceof GitMetadataError) {
    return error;
  }
  return new GitMetadataError(
    "METADATA_STORAGE_FAILED",
    `IndexedDB ${operation} failed`,
    {
      operation,
      repoId,
      causeName: error?.name ?? "Error",
      causeMessage: error?.message ?? String(error),
    },
  );
}

function injectFault(mutation, stage, committed) {
  if (mutation.faultAt === stage) {
    fail("INJECTED_FAULT", `Injected fault at ${stage}`, {
      stage,
      committed,
    });
  }
}

function applyUpdates(current, updates) {
  const next = cloneValue(current);
  next.revision = current.revision + 1;

  if (updates.refs !== undefined) {
    for (const name of Object.keys(updates.refs).sort()) {
      const oid = updates.refs[name];
      if (oid === null) {
        delete next.refs[name];
      } else {
        next.refs[name] = oid;
      }
    }
    assertNoDirectoryFileCollision(next.refs, "mutation.updates.refs");
  }
  if (updates.head !== undefined) {
    next.head = updates.head;
  }
  if (updates.config !== undefined) {
    next.config = updates.config;
  }
  if (updates.shallow !== undefined) {
    next.shallow = updates.shallow;
  }
  return next;
}

export function createGitMetadataStore(options = {}) {
  const databaseName = options.databaseName ?? DEFAULT_DATABASE_NAME;
  const idb = options.indexedDB ?? globalThis.indexedDB;
  const uuidSource = options.crypto ?? globalThis.crypto;
  const objectStoreSource =
    options.objectStore ?? (() => globalThis.__gitObjectStore);

  assertNonEmptyString(databaseName, "options.databaseName");
  if (idb === undefined) {
    fail("INDEXEDDB_UNAVAILABLE", "IndexedDB is unavailable in this runtime");
  }

  let databasePromise;

  function openDatabase() {
    if (databasePromise !== undefined) {
      return databasePromise;
    }
    databasePromise = new Promise((resolve, reject) => {
      const request = idb.open(databaseName, DATABASE_VERSION);
      request.addEventListener("upgradeneeded", () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(REPOSITORIES_STORE)) {
          database.createObjectStore(REPOSITORIES_STORE, { keyPath: "repoId" });
        }
        if (!database.objectStoreNames.contains(RECEIPTS_STORE)) {
          const receipts = database.createObjectStore(RECEIPTS_STORE, {
            keyPath: ["repoId", "idempotencyKey"],
          });
          receipts.createIndex(RECEIPTS_BY_REPOSITORY, "repoId", {
            unique: false,
          });
        }
      });
      request.addEventListener("success", () => resolve(request.result), {
        once: true,
      });
      request.addEventListener(
        "error",
        () => reject(request.error ?? new Error("IndexedDB open failed")),
        { once: true },
      );
      request.addEventListener(
        "blocked",
        () =>
          reject(
            new GitMetadataError(
              "METADATA_STORAGE_BLOCKED",
              "IndexedDB upgrade is blocked by another connection",
              { databaseName },
            ),
          ),
        { once: true },
      );
    }).catch((error) => {
      databasePromise = undefined;
      throw error;
    });
    return databasePromise;
  }

  async function snapshot(repoId) {
    normalizeRepositoryId(repoId);
    try {
      const database = await openDatabase();
      const transaction = database.transaction(REPOSITORIES_STORE, "readonly");
      const done = transactionComplete(transaction);
      const state = await requestResult(
        transaction.objectStore(REPOSITORIES_STORE).get(repoId),
      );
      await done;
      if (state === undefined) {
        fail("REPOSITORY_NOT_FOUND", "Repository metadata does not exist", {
          repoId,
        });
      }
      return cloneValue(state);
    } catch (error) {
      throw mapStorageError(error, "snapshot", repoId);
    }
  }

  async function initialize(repoId, initial = {}) {
    normalizeRepositoryId(repoId);
    if (typeof uuidSource?.randomUUID !== "function") {
      fail("CRYPTO_UNAVAILABLE", "crypto.randomUUID is required for generations");
    }
    const next = normalizeInitial(repoId, initial, uuidSource.randomUUID());
    try {
      const database = await openDatabase();
      const transaction = database.transaction(
        [REPOSITORIES_STORE, RECEIPTS_STORE],
        "readwrite",
      );
      const done = transactionComplete(transaction);
      const repositories = transaction.objectStore(REPOSITORIES_STORE);
      const existing = await requestResult(repositories.get(repoId));
      if (existing !== undefined) {
        transaction.abort();
        try {
          await done;
        } catch {
          // The explicit abort prevents publication; expose the domain error below.
        }
        fail("REPOSITORY_EXISTS", "Repository metadata already exists", {
          repoId,
          generation: existing.generation,
          revision: existing.revision,
        });
      }
      await deleteReceiptsForRepository(
        transaction.objectStore(RECEIPTS_STORE),
        repoId,
      );
      repositories.add(next);
      await done;
      return cloneValue(next);
    } catch (error) {
      throw mapStorageError(error, "initialize", repoId);
    }
  }

  async function reset(repoId) {
    normalizeRepositoryId(repoId);
    try {
      const database = await openDatabase();
      const transaction = database.transaction(
        [REPOSITORIES_STORE, RECEIPTS_STORE],
        "readwrite",
      );
      const done = transactionComplete(transaction);
      const repositories = transaction.objectStore(REPOSITORIES_STORE);
      const existing = await requestResult(repositories.get(repoId));
      await deleteReceiptsForRepository(
        transaction.objectStore(RECEIPTS_STORE),
        repoId,
      );
      repositories.delete(repoId);
      await done;
      return { repoId, deleted: existing !== undefined };
    } catch (error) {
      throw mapStorageError(error, "reset", repoId);
    }
  }

  async function verifyRequiredObjects(repoId, mutation) {
    const objectStore =
      typeof objectStoreSource === "function"
        ? objectStoreSource()
        : objectStoreSource;
    if (
      mutation.requiredObjects.length > 0 &&
      (objectStore === undefined || typeof objectStore.exists !== "function")
    ) {
      fail(
        "OBJECT_STORE_UNAVAILABLE",
        "globalThis.__gitObjectStore.exists(path) is required",
        { repoId },
      );
    }

    for (const oid of mutation.requiredObjects) {
      const path = `repos/${repoId}/objects/${oid}`;
      let ready;
      try {
        ready = await objectStore.exists(path);
      } catch (error) {
        fail("OBJECT_READINESS_FAILED", "Object readiness check failed", {
          repoId,
          oid,
          path,
          causeName: error?.name ?? "Error",
          causeMessage: error?.message ?? String(error),
        });
      }
      if (ready !== true) {
        fail("OBJECT_NOT_READY", "Required Git object is not ready", {
          repoId,
          oid,
          path,
        });
      }
    }
  }

  async function commit(repoId, rawMutation) {
    normalizeRepositoryId(repoId);
    const mutation = normalizeMutation(rawMutation);
    injectFault(mutation, "beforeObjectReady", false);
    await verifyRequiredObjects(repoId, mutation);
    injectFault(mutation, "afterObjectReady", false);
    injectFault(mutation, "beforeMetadataCommit", false);

    let result;
    let conflict;
    let published = false;
    try {
      const database = await openDatabase();
      const transaction = database.transaction(
        [REPOSITORIES_STORE, RECEIPTS_STORE],
        "readwrite",
      );
      const done = transactionComplete(transaction);
      const repositories = transaction.objectStore(REPOSITORIES_STORE);
      const receipts = transaction.objectStore(RECEIPTS_STORE);
      const [current, receipt] = await Promise.all([
        requestResult(repositories.get(repoId)),
        requestResult(receipts.get([repoId, mutation.idempotencyKey])),
      ]);

      if (receipt !== undefined) {
        if (receipt.digest !== mutation.digest) {
          conflict = new GitMetadataError(
            "IDEMPOTENCY_KEY_REUSED",
            "Idempotency key was already used with a different digest",
            { repoId, idempotencyKey: mutation.idempotencyKey },
          );
        } else {
          result = receipt.result;
        }
      } else if (current === undefined) {
        conflict = new GitMetadataError(
          "REPOSITORY_NOT_FOUND",
          "Repository metadata does not exist",
          { repoId },
        );
      } else if (current.generation !== mutation.expectedGeneration) {
        conflict = new GitMetadataError(
          "GENERATION_CONFLICT",
          "Repository generation does not match",
          {
            repoId,
            expected: mutation.expectedGeneration,
            actual: current.generation,
          },
        );
      } else if (current.revision !== mutation.expectedRevision) {
        conflict = new GitMetadataError(
          "REVISION_CONFLICT",
          "Repository revision does not match",
          {
            repoId,
            expected: mutation.expectedRevision,
            actual: current.revision,
          },
        );
      } else {
        for (const name of Object.keys(mutation.expectedRefs).sort()) {
          const expected = mutation.expectedRefs[name];
          const actual = hasOwn(current.refs, name) ? current.refs[name] : null;
          if (actual !== expected) {
            conflict = new GitMetadataError(
              "REF_CONFLICT",
              "Git ref does not match its expected old OID",
              { repoId, name, expected, actual },
            );
            break;
          }
        }

        if (conflict === undefined) {
          const next = applyUpdates(current, mutation.updates);
          result = {
            repoId,
            generation: next.generation,
            previousRevision: current.revision,
            revision: next.revision,
            state: next,
          };
          repositories.put(next);
          receipts.put({
            repoId,
            idempotencyKey: mutation.idempotencyKey,
            digest: mutation.digest,
            result,
          });
          published = true;
        }
      }

      await done;
    } catch (error) {
      throw mapStorageError(error, "commit", repoId);
    }

    if (conflict !== undefined) {
      throw conflict;
    }
    if (published) {
      injectFault(mutation, "afterMetadataCommit", true);
    }
    return cloneValue(result);
  }

  async function close() {
    if (databasePromise === undefined) {
      return;
    }
    const database = await databasePromise;
    database.close();
    databasePromise = undefined;
  }

  return { snapshot, initialize, commit, reset, close };
}

const defaultStore = createGitMetadataStore();

globalThis.__gitMetadataStore = Object.freeze({
  snapshot: defaultStore.snapshot,
  initialize: defaultStore.initialize,
  commit: defaultStore.commit,
  reset: defaultStore.reset,
});
