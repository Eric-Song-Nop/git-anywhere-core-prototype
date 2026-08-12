function serializeError(error) {
  const result = {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
  };
  for (const property of [
    "code",
    "operation",
    "path",
    "retryable",
    "details",
  ]) {
    if (error?.[property] !== undefined) result[property] = error[property];
  }
  return result;
}

function branchRef(branch = "main") {
  return `refs/heads/${branch}`;
}

function currentBranchOid(state, branch = "main") {
  return state.refs?.[branchRef(branch)] ?? null;
}

function commitOptions(repoId, state, label, branch = "main") {
  return {
    branch,
    idempotencyKey: `${repoId}:demo:${label}:${crypto.randomUUID()}`,
    expectedGeneration: state.generation,
    expectedRevision: state.revision,
    expectedBranchOid: currentBranchOid(state, branch),
  };
}

async function initializeRuntime() {
  importScripts(new URL("../go-git/wasm_exec.js", self.location).href);
  const { installGitObjectStore } = await import("../rust-opendal/bridge.js");
  await installGitObjectStore("git-anywhere/demo-v1");
  await import("../web/git-metadata-store.js");
  const { installGitCore } = await import("../go-git/loader.js");
  const { core } = await installGitCore(
    new URL("../go-git/git-core.wasm", self.location),
  );
  return { core, metadataStore: globalThis.__gitMetadataStore };
}

async function readState(core, repoId) {
  const metadata = await core.open(repoId);
  if (!metadata.resolvedHeadOid) return metadata;
  return core.readCommitState(repoId);
}

async function runWriterRace(core, repoId) {
  const before = await core.open(repoId);
  const attempts = ["a", "b"].map((writer) => ({
    writer,
    options: commitOptions(repoId, before, `race-${writer}`),
  }));
  const settled = await Promise.allSettled(
    attempts.map(({ options }) => core.createCommit(repoId, options)),
  );
  const outcomes = settled.map((result, index) =>
    result.status === "fulfilled"
      ? {
          writer: attempts[index].writer,
          status: "fulfilled",
          result: result.value,
        }
      : {
          writer: attempts[index].writer,
          status: "rejected",
          error: serializeError(result.reason),
        },
  );
  const winners = outcomes.filter(({ status }) => status === "fulfilled");
  const losers = outcomes.filter(({ status }) => status === "rejected");
  if (
    winners.length !== 1 ||
    losers.length !== 1 ||
    losers[0].error.code !== "CONFLICT"
  ) {
    const error = new Error(
      "The writer race did not produce one winner and one conflict",
    );
    error.name = "DemoAssertionError";
    error.details = { outcomes };
    throw error;
  }
  return { before, outcomes, state: await core.readCommitState(repoId) };
}

async function resetRepository(runtime, repoId) {
  // Demo reset intentionally removes only mutable authority. Immutable OPFS
  // objects remain valid content-addressed bytes and may be reused by a later
  // initialization of the same repository ID.
  return runtime.metadataStore.reset(repoId);
}

async function execute(runtime, command, payload) {
  const repoId = payload?.repoId;
  switch (command) {
    case "initialize":
      return { state: await runtime.core.init(repoId, { branch: "main" }) };
    case "open":
      return { state: await readState(runtime.core, repoId) };
    case "commit": {
      const before = await runtime.core.open(repoId);
      const proof = await runtime.core.createCommit(
        repoId,
        commitOptions(repoId, before, "commit"),
      );
      return {
        before,
        proof,
        state: await runtime.core.readCommitState(repoId),
      };
    }
    case "race":
      return runWriterRace(runtime.core, repoId);
    case "reset":
      return resetRepository(runtime, repoId);
    default:
      throw new Error(`Unknown demo command: ${command}`);
  }
}

const runtimeId = crypto.randomUUID();
const runtimePromise = initializeRuntime();
runtimePromise.then(
  () =>
    postMessage({
      type: "ready",
      dedicatedWorker: typeof Window === "undefined",
      runtimeId,
    }),
  (error) => postMessage({ type: "boot-error", error: serializeError(error) }),
);

let commandQueue = Promise.resolve();
self.addEventListener("message", ({ data }) => {
  if (data?.type !== "request" || typeof data.requestId !== "string") return;
  const run = async () => {
    try {
      const runtime = await runtimePromise;
      const result = await execute(runtime, data.command, data.payload);
      postMessage({
        type: "response",
        requestId: data.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      postMessage({
        type: "response",
        requestId: data.requestId,
        ok: false,
        error: serializeError(error),
      });
    }
  };
  commandQueue = commandQueue.then(run, run);
});
