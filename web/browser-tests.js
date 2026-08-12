import { createGitMetadataStore } from "./git-metadata-store.js";

const DATABASE_NAME = "git-anywhere-metadata-browser-contract-v1";
const OLD_OID = "1111111111111111111111111111111111111111";
const A_OID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const B_OID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TAG_OID = "cccccccccccccccccccccccccccccccccccccccc";
const SHALLOW_OID = "dddddddddddddddddddddddddddddddddddddddd";
const runId = new URL(location.href).searchParams.get("run") ?? "manual";
const phaseKey = `git-metadata-test-phase:${runId}`;
const reloadStateKey = `git-metadata-test-state:${runId}`;
const readyObjects = new Set([OLD_OID, A_OID, B_OID, TAG_OID, SHALLOW_OID]);
let readinessChecks = [];

globalThis.__gitObjectStore = {
  async exists(path) {
    const match = /^repos\/([^/]+)\/objects\/([^/]+)$/.exec(path);
    assert(match !== null, "object readiness path has wrong shape", { path });
    const [, repoId, oid] = match;
    readinessChecks.push({ repoId, oid, path });
    return readyObjects.has(oid);
  },
};

function assert(condition, message, details = {}) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function assertEqual(actual, expected, message) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  assert(actualJson === expectedJson, message, { actual, expected });
}

async function expectError(action, code, expectedDetails = {}) {
  try {
    await action();
  } catch (error) {
    assert(error.code === code, `expected ${code}, got ${error.code}`, {
      error: {
        name: error.name,
        message: error.message,
        code: error.code,
        details: error.details,
      },
    });
    for (const [key, value] of Object.entries(expectedDetails)) {
      assertEqual(error.details?.[key], value, `wrong ${code} detail ${key}`);
    }
    return error;
  }
  throw new Error(`expected ${code}, but operation succeeded`);
}

function mutation(state, overrides = {}) {
  return {
    idempotencyKey: overrides.idempotencyKey ?? crypto.randomUUID(),
    digest: overrides.digest ?? crypto.randomUUID(),
    expectedGeneration: overrides.expectedGeneration ?? state.generation,
    expectedRevision: overrides.expectedRevision ?? state.revision,
    expectedRefs: overrides.expectedRefs ?? {},
    updates: overrides.updates ?? {},
    requiredObjects: overrides.requiredObjects ?? [],
    ...(overrides.faultAt === undefined ? {} : { faultAt: overrides.faultAt }),
  };
}

async function testConcurrentCas() {
  const repoId = `race-${runId}`;
  const coordinator = createGitMetadataStore({ databaseName: DATABASE_NAME });
  const initial = await coordinator.initialize(repoId, {
    refs: { "refs/heads/main": OLD_OID },
    head: { kind: "symbolic", target: "refs/heads/main" },
    config: { branch: "main", winner: null },
    shallow: [],
  });
  const writerA = createGitMetadataStore({ databaseName: DATABASE_NAME });
  const writerB = createGitMetadataStore({ databaseName: DATABASE_NAME });
  const common = {
    expectedGeneration: initial.generation,
    expectedRevision: 0,
    expectedRefs: { "refs/heads/main": OLD_OID },
  };
  const mutationA = mutation(initial, {
    ...common,
    idempotencyKey: "writer-a",
    digest: "digest-writer-a",
    requiredObjects: [A_OID, TAG_OID],
    updates: {
      refs: { "refs/heads/main": A_OID, "refs/tags/winner": TAG_OID },
      config: { branch: "main", winner: "a" },
    },
  });
  const mutationB = mutation(initial, {
    ...common,
    idempotencyKey: "writer-b",
    digest: "digest-writer-b",
    requiredObjects: [B_OID, TAG_OID],
    updates: {
      refs: { "refs/heads/main": B_OID, "refs/tags/winner": TAG_OID },
      config: { branch: "main", winner: "b" },
    },
  });

  const outcomes = await Promise.allSettled([
    writerA.commit(repoId, mutationA),
    writerB.commit(repoId, mutationB),
  ]);
  const winners = outcomes.filter((entry) => entry.status === "fulfilled");
  const losers = outcomes.filter((entry) => entry.status === "rejected");
  assert(winners.length === 1, "exactly one old-OID CAS writer must win", {
    outcomes,
  });
  assert(losers.length === 1, "exactly one old-OID CAS writer must lose", {
    outcomes,
  });
  assertEqual(losers[0].reason.code, "REVISION_CONFLICT", "wrong CAS loss");

  const winnerName = winners[0].value.state.config.winner;
  const winnerOid = winnerName === "a" ? A_OID : B_OID;
  const snapshot = await coordinator.snapshot(repoId);
  assertEqual(snapshot.revision, 1, "race must publish one revision");
  assertEqual(
    snapshot.refs,
    { "refs/heads/main": winnerOid, "refs/tags/winner": TAG_OID },
    "all winner refs must publish atomically",
  );
  assertEqual(
    snapshot.config,
    { branch: "main", winner: winnerName },
    "winner config and refs must be from the same mutation",
  );

  await Promise.all([writerA.close(), writerB.close(), coordinator.close()]);
  return { winner: winnerName, losingCode: losers[0].reason.code };
}

async function testFaultBoundaries() {
  const store = createGitMetadataStore({ databaseName: DATABASE_NAME });
  const results = {};
  for (const stage of [
    "beforeObjectReady",
    "afterObjectReady",
    "beforeMetadataCommit",
  ]) {
    const repoId = `fault-${stage}-${runId}`;
    const initial = await store.initialize(repoId, {
      refs: { "refs/heads/main": OLD_OID },
      config: { marker: "before" },
    });
    readinessChecks = [];
    await expectError(
      () =>
        store.commit(
          repoId,
          mutation(initial, {
            idempotencyKey: `fault-${stage}`,
            digest: `digest-${stage}`,
            expectedRefs: { "refs/heads/main": OLD_OID },
            requiredObjects: [A_OID, TAG_OID],
            updates: {
              refs: {
                "refs/heads/main": A_OID,
                "refs/tags/atomic": TAG_OID,
              },
              head: { kind: "detached", oid: A_OID },
              config: { marker: "after" },
              shallow: [SHALLOW_OID],
            },
            faultAt: stage,
          }),
        ),
      "INJECTED_FAULT",
      { stage, committed: false },
    );
    const after = await store.snapshot(repoId);
    assertEqual(after, initial, `${stage} must not publish partial metadata`);
    assertEqual(
      readinessChecks.length,
      stage === "beforeObjectReady" ? 0 : 2,
      `${stage} object-readiness boundary is wrong`,
    );
    results[stage] = { revision: after.revision, checks: readinessChecks.length };
  }

  const repoId = `fault-afterMetadataCommit-${runId}`;
  const initial = await store.initialize(repoId, {
    refs: { "refs/heads/main": OLD_OID, "refs/heads/delete-me": OLD_OID },
    config: { marker: "before" },
  });
  const ambiguous = mutation(initial, {
    idempotencyKey: "ambiguous-commit",
    digest: "digest-ambiguous-commit",
    expectedRefs: {
      "refs/heads/main": OLD_OID,
      "refs/heads/delete-me": OLD_OID,
      "refs/tags/atomic": null,
    },
    requiredObjects: [A_OID, TAG_OID, SHALLOW_OID],
    updates: {
      refs: {
        "refs/heads/main": A_OID,
        "refs/heads/delete-me": null,
        "refs/tags/atomic": TAG_OID,
      },
      head: { kind: "detached", oid: A_OID },
      config: { marker: "after", nested: { durable: true } },
      shallow: [SHALLOW_OID],
    },
    faultAt: "afterMetadataCommit",
  });
  await expectError(
    () => store.commit(repoId, ambiguous),
    "INJECTED_FAULT",
    { stage: "afterMetadataCommit", committed: true },
  );
  const fullyPublished = await store.snapshot(repoId);
  assertEqual(fullyPublished.revision, 1, "ambiguous commit must publish once");
  assertEqual(
    fullyPublished.refs,
    { "refs/heads/main": A_OID, "refs/tags/atomic": TAG_OID },
    "post-commit fault must expose all ref updates, including deletion",
  );
  assertEqual(
    fullyPublished.head,
    { kind: "detached", oid: A_OID },
    "HEAD must publish in the same transaction",
  );
  assertEqual(
    fullyPublished.config,
    { marker: "after", nested: { durable: true } },
    "config must publish in the same transaction",
  );
  assertEqual(
    fullyPublished.shallow,
    [SHALLOW_OID],
    "shallow roots must publish in the same transaction",
  );

  const firstReplay = await store.commit(repoId, ambiguous);
  const retry = { ...ambiguous };
  delete retry.faultAt;
  const secondReplay = await store.commit(repoId, retry);
  assertEqual(firstReplay, secondReplay, "idempotent replay result must be exact");
  assertEqual(
    firstReplay.state,
    fullyPublished,
    "ambiguous retry must recover the stored result",
  );
  assertEqual(
    (await store.snapshot(repoId)).revision,
    1,
    "idempotent retries must not advance revision",
  );
  await expectError(
    () => store.commit(repoId, { ...retry, digest: "different-digest" }),
    "IDEMPOTENCY_KEY_REUSED",
  );
  results.afterMetadataCommit = {
    revision: fullyPublished.revision,
    exactReplay: true,
  };
  await store.close();
  return results;
}

async function testObjectReadinessAndGeneration() {
  const store = createGitMetadataStore({ databaseName: DATABASE_NAME });
  const repoId = `guards-${runId}`;
  const first = await store.initialize(repoId, {
    refs: { "refs/heads/main": OLD_OID },
  });
  const missingOid = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  await expectError(
    () =>
      store.commit(
        repoId,
        mutation(first, {
          idempotencyKey: "missing-object",
          digest: "digest-missing-object",
          requiredObjects: [missingOid],
          updates: { refs: { "refs/heads/main": missingOid } },
        }),
      ),
    "OBJECT_NOT_READY",
    { oid: missingOid },
  );
  assertEqual(
    await store.snapshot(repoId),
    first,
    "missing objects must not publish metadata",
  );

  await expectError(
    () => store.initialize(repoId, { refs: { "refs/heads/main": B_OID } }),
    "REPOSITORY_EXISTS",
  );
  assertEqual(
    await store.snapshot(repoId),
    first,
    "failed create-only initialize must preserve live state",
  );
  await store.reset(repoId);
  const second = await store.initialize(repoId, {
    refs: { "refs/heads/main": B_OID },
  });
  assert(first.generation !== second.generation, "reset and initialize must change generation");
  await expectError(
    () =>
      store.commit(
        repoId,
        mutation(first, {
          idempotencyKey: "stale-generation",
          digest: "digest-stale-generation",
          expectedRefs: { "refs/heads/main": OLD_OID },
          updates: {},
        }),
      ),
    "GENERATION_CONFLICT",
  );
  await store.close();
  return {
    createOnlyInitialize: true,
    generationChanged: true,
    missingObjectRejected: true,
  };
}

async function prepareReloadContract() {
  const store = createGitMetadataStore({ databaseName: DATABASE_NAME });
  const repoId = `reload-${runId}`;
  const initial = await store.initialize(repoId, {
    refs: { "refs/heads/main": OLD_OID },
    config: { persisted: false },
  });
  const durableMutation = mutation(initial, {
    idempotencyKey: "reload-idempotency-key",
    digest: "reload-digest",
    expectedRefs: { "refs/heads/main": OLD_OID },
    requiredObjects: [A_OID],
    updates: {
      refs: { "refs/heads/main": A_OID },
      config: { persisted: true },
    },
  });
  const result = await store.commit(repoId, durableMutation);
  sessionStorage.setItem(
    reloadStateKey,
    JSON.stringify({ repoId, expectedState: result.state, durableMutation }),
  );
  await store.close();
}

async function verifyReloadContract() {
  const saved = JSON.parse(sessionStorage.getItem(reloadStateKey));
  assert(saved !== null, "reload test state is missing");
  const reopened = createGitMetadataStore({ databaseName: DATABASE_NAME });
  const snapshot = await reopened.snapshot(saved.repoId);
  assertEqual(snapshot, saved.expectedState, "metadata must persist across page reload");
  const replay = await reopened.commit(saved.repoId, saved.durableMutation);
  assertEqual(
    replay.state,
    saved.expectedState,
    "idempotency receipt must persist across page reload",
  );
  assertEqual(
    (await reopened.snapshot(saved.repoId)).revision,
    1,
    "reload replay must not double-commit",
  );
  await reopened.close();

  const secondConnection = createGitMetadataStore({ databaseName: DATABASE_NAME });
  assertEqual(
    await secondConnection.snapshot(saved.repoId),
    saved.expectedState,
    "fresh IndexedDB connection must reopen the same state",
  );
  await secondConnection.close();
  return { revision: snapshot.revision, receiptReplayed: true };
}

function publish(status, result) {
  document.body.dataset.status = status;
  document.querySelector("#results").textContent = JSON.stringify(result);
}

async function main() {
  try {
    if (sessionStorage.getItem(phaseKey) !== "reload") {
      const firstPhase = {
        concurrentCas: await testConcurrentCas(),
        faultBoundaries: await testFaultBoundaries(),
        guards: await testObjectReadinessAndGeneration(),
      };
      await prepareReloadContract();
      sessionStorage.setItem(phaseKey, "reload");
      sessionStorage.setItem(`${phaseKey}:results`, JSON.stringify(firstPhase));
      location.reload();
      return;
    }

    const firstPhase = JSON.parse(sessionStorage.getItem(`${phaseKey}:results`));
    const result = {
      ok: true,
      ...firstPhase,
      reloadReopen: await verifyReloadContract(),
    };
    sessionStorage.removeItem(phaseKey);
    sessionStorage.removeItem(`${phaseKey}:results`);
    sessionStorage.removeItem(reloadStateKey);
    publish("passed", result);
  } catch (error) {
    publish("failed", {
      ok: false,
      error: {
        name: error.name,
        message: error.message,
        code: error.code,
        details: error.details,
        stack: error.stack,
      },
    });
  }
}

await main();
