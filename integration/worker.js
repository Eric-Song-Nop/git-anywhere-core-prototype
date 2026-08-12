function assert(condition, message, details = undefined) {
  if (condition) return;
  const error = new Error(message);
  error.name = "IntegrationAssertionError";
  error.details = details;
  throw error;
}

function errorDetails(error) {
  const details = {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
  };
  for (const property of ["code", "operation", "path", "retryable", "details"]) {
    if (error?.[property] !== undefined) details[property] = error[property];
  }
  if (typeof error?.stack === "string") details.stack = error.stack;
  return details;
}

function sameCommitProof(left, right) {
  return ["blobOid", "treeOid", "commitOid", "revision", "generation"].every(
    (field) => left?.[field] === right?.[field],
  );
}

function validateCommittedState(state, initial, commit) {
  assert(state.generation === initial.generation, "generation changed during commit", {
    initial: initial.generation,
    actual: state.generation,
  });
  assert(state.revision === 1, "exactly one metadata revision must publish", {
    revision: state.revision,
  });
  assert(
    state.refs?.["refs/heads/main"] === commit.commitOid,
    "main does not name the winning commit",
    { refs: state.refs, commitOid: commit.commitOid },
  );
  assert(
    state.head?.kind === "symbolic" && state.head?.target === "refs/heads/main",
    "HEAD must remain symbolic to main",
    { head: state.head },
  );
  assert(state.resolvedHeadOid === commit.commitOid, "HEAD did not resolve to winner", {
    resolvedHeadOid: state.resolvedHeadOid,
    commitOid: commit.commitOid,
  });
  assert(Array.isArray(state.objects) && state.objects.length === 3, "expected three reachable objects", {
    objects: state.objects,
  });
  const types = state.objects.map((object) => object.type).sort().join(",");
  assert(types === "blob,commit,tree", "reachable object types are incomplete", { types });
  for (const object of state.objects) {
    assert(/^[0-9a-f]{40}$/.test(object.oid), "exported object has an invalid OID", object);
    assert(typeof object.base64 === "string" && object.base64.length > 0, "object payload is absent", {
      oid: object.oid,
    });
  }
}

async function phase1(core, repoId) {
  const initial = await core.init(repoId, { branch: "main" });
  assert(initial.revision === 0, "new repository must start at revision zero", initial);
  assert(initial.generation, "new repository did not receive a generation", initial);
  assert(initial.refs?.["refs/heads/main"] === undefined, "main must initially be absent", initial);

  const fence = Object.freeze({
    branch: "main",
    expectedGeneration: initial.generation,
    expectedRevision: initial.revision,
    expectedBranchOid: null,
  });
  const writers = [
    { writer: "a", idempotencyKey: `${repoId}-writer-a` },
    { writer: "b", idempotencyKey: `${repoId}-writer-b` },
  ];

  // Both calls synchronously return Promises before either Go goroutine can
  // finish. They therefore race one explicit old-generation/revision/ref fence.
  const settled = await Promise.allSettled(
    writers.map(({ idempotencyKey }) =>
      core.createCommit(repoId, { ...fence, idempotencyKey }),
    ),
  );
  const attempts = settled.map((outcome, index) =>
    outcome.status === "fulfilled"
      ? { ...writers[index], status: "fulfilled", result: outcome.value }
      : { ...writers[index], status: "rejected", error: errorDetails(outcome.reason) },
  );
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled");
  const losers = attempts.filter((attempt) => attempt.status === "rejected");
  assert(winners.length === 1 && losers.length === 1, "CAS race did not produce exactly one winner", {
    attempts,
  });
  assert(losers[0].error.code === "CONFLICT", "losing old-fence writer was not rejected as a conflict", {
    loser: losers[0],
  });

  const winner = winners[0];
  const replay = await core.createCommit(repoId, {
    ...fence,
    idempotencyKey: winner.idempotencyKey,
  });
  assert(sameCommitProof(replay, winner.result), "ambiguous retry did not return the exact receipt", {
    winner: winner.result,
    replay,
  });

  const state = await core.readCommitState(repoId);
  validateCommittedState(state, initial, winner.result);
  assert(replay.revision === state.revision, "receipt replay advanced metadata revision", {
    replayRevision: replay.revision,
    stateRevision: state.revision,
  });

  return {
    ok: true,
    phase: "phase1",
    repoId,
    dedicatedWorker: typeof Window === "undefined",
    initial,
    fence,
    attempts,
    winner: { writer: winner.writer, idempotencyKey: winner.idempotencyKey, result: winner.result },
    loser: { writer: losers[0].writer, idempotencyKey: losers[0].idempotencyKey, error: losers[0].error },
    ambiguousRetry: {
      originalFenceReused: true,
      originalKeyReused: true,
      exactReceipt: true,
      result: replay,
    },
    state,
  };
}

async function phase2(core, repoId) {
  const opened = await core.open(repoId);
  const state = await core.readCommitState(repoId);
  assert(opened.revision === 1 && state.revision === 1, "reopened metadata revision is not one", {
    opened,
    state,
  });
  assert(opened.generation === state.generation, "open/read generation mismatch after restart", {
    openedGeneration: opened.generation,
    stateGeneration: state.generation,
  });
  assert(opened.resolvedHeadOid === state.resolvedHeadOid, "open/read HEAD mismatch after restart", {
    opened,
    state,
  });
  assert(state.objects?.length === 3, "reopened repository is missing reachable objects", state);
  return {
    ok: true,
    phase: "phase2",
    repoId,
    dedicatedWorker: typeof Window === "undefined",
    opened,
    state,
  };
}

async function main() {
  const parameters = new URL(self.location.href).searchParams;
  const phase = parameters.get("phase") ?? "phase1";
  const repoId = parameters.get("repoId") ?? "integration-proof";

  importScripts(new URL("../go-git/wasm_exec.js", self.location).href);
  const { installGitObjectStore } = await import("../rust-opendal/bridge.js");
  await installGitObjectStore("git-anywhere/core-v1");
  await import("../web/git-metadata-store.js");
  const { installGitCore } = await import("../go-git/loader.js");
  const { core } = await installGitCore(
    new URL("../go-git/git-core.wasm", self.location),
  );

  if (phase === "phase1") return phase1(core, repoId);
  if (phase === "phase2") return phase2(core, repoId);
  throw new Error(`unknown integration phase: ${phase}`);
}

main().then(
  (result) => postMessage(result),
  (error) =>
    postMessage({
      ok: false,
      phase: new URL(self.location.href).searchParams.get("phase"),
      error: errorDetails(error),
    }),
);
