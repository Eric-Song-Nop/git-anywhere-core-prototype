const result = document.querySelector("#result");
const parameters = new URL(location.href).searchParams;
const phase = parameters.get("phase") ?? "phase1";
const repoId = parameters.get("repoId") ?? "integration-proof";
const run = parameters.get("run") ?? "manual";

let finished = false;
const worker = new Worker(
  `./worker.js?phase=${encodeURIComponent(phase)}&repoId=${encodeURIComponent(repoId)}&run=${encodeURIComponent(run)}`,
  { name: `git-anywhere-${phase}` },
);

function finish(status, payload) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  worker.terminate();
  globalThis.__integrationResult = payload;
  result.textContent = JSON.stringify(payload);
  document.body.dataset.status = status;
}

worker.addEventListener("message", ({ data }) => {
  finish(data?.ok === true ? "passed" : "failed", data);
});

worker.addEventListener("error", (event) => {
  finish("failed", {
    ok: false,
    phase,
    error: {
      name: "WorkerError",
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno,
    },
  });
});

const timeout = setTimeout(() => {
  finish("failed", {
    ok: false,
    phase,
    error: {
      name: "TimeoutError",
      message: `integration worker did not finish ${phase} within 90 seconds`,
    },
  });
}, 90_000);
