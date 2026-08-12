const elements = {
  runtimeStatus: document.querySelector("#runtime-status"),
  runtimeStatusCopy: document.querySelector("#runtime-status-copy"),
  actionStatus: document.querySelector("#action-status"),
  console: document.querySelector("#repository-console"),
  repoForm: document.querySelector("#repo-form"),
  repoId: document.querySelector("#repo-id"),
  openButton: document.querySelector("#open-button"),
  initButton: document.querySelector("#init-button"),
  commitButton: document.querySelector("#commit-button"),
  raceButton: document.querySelector("#race-button"),
  reloadButton: document.querySelector("#reload-button"),
  resetButton: document.querySelector("#reset-button"),
  notice: document.querySelector("#notice"),
  stateChip: document.querySelector("#state-chip"),
  revision: document.querySelector("#revision-value"),
  objectCount: document.querySelector("#object-count-value"),
  generation: document.querySelector("#generation-value"),
  head: document.querySelector("#head-value"),
  refsEmpty: document.querySelector("#refs-empty"),
  refList: document.querySelector("#ref-list"),
  objectsEmpty: document.querySelector("#objects-empty"),
  objectList: document.querySelector("#object-list"),
  rawState: document.querySelector("#raw-state"),
  objectPlaneCopy: document.querySelector("#object-plane-copy"),
  controlPlaneCopy: document.querySelector("#control-plane-copy"),
  proofVerdict: document.querySelector("#proof-verdict"),
  writerLanes: document.querySelector("#writer-lanes"),
  eventLog: document.querySelector("#event-log"),
  resetDialog: document.querySelector("#reset-dialog"),
  resetRepoName: document.querySelector("#reset-repo-name"),
  resetCancel: document.querySelector("#reset-cancel"),
  resetConfirm: document.querySelector("#reset-confirm"),
};

const state = {
  ready: false,
  busy: false,
  repository: null,
  raceOutcomes: null,
  runtimeId: null,
  events: [],
};
const pending = new Map();
const worker = new Worker("./worker.js", { name: "git-anywhere-demo" });

function request(command, payload) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`${command} did not finish within 60 seconds`));
    }, 60_000);
    pending.set(requestId, { resolve, reject, timeout });
    worker.postMessage({ type: "request", requestId, command, payload });
  });
}

function comparableState(repository) {
  const refs = Object.fromEntries(
    Object.entries(repository.refs ?? {}).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  const objects = (repository.objects ?? [])
    .map(({ type, oid, base64 }) => ({ type, oid, base64 }))
    .sort(
      (left, right) =>
        left.oid.localeCompare(right.oid) ||
        left.type.localeCompare(right.type),
    );
  return {
    generation: repository.generation,
    revision: repository.revision,
    head: repository.head,
    resolvedHeadOid: repository.resolvedHeadOid ?? "",
    refs,
    objects,
  };
}

function currentRepoId() {
  return elements.repoId.value.trim();
}

function formatError(error) {
  const code = error?.code ? `${error.code}: ` : "";
  return `${code}${error?.message ?? String(error)}`;
}

function setNotice(message = "", kind = "neutral") {
  elements.notice.hidden = message.length === 0;
  elements.notice.dataset.kind = kind;
  elements.notice.textContent = message;
}

function addEvent(message, kind = "neutral") {
  state.events.unshift({ message, kind, time: new Date() });
  state.events = state.events.slice(0, 8);
  elements.eventLog.replaceChildren(
    ...state.events.map((event) => {
      const item = document.createElement("li");
      item.dataset.kind = event.kind;
      const time = document.createElement("time");
      time.dateTime = event.time.toISOString();
      time.textContent = event.time.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
      const copy = document.createElement("span");
      copy.textContent = event.message;
      item.append(time, copy);
      return item;
    }),
  );
}

function setBusy(busy, label = "") {
  state.busy = busy;
  elements.console.setAttribute("aria-busy", String(busy));
  elements.actionStatus.textContent = busy
    ? label
    : state.ready
      ? "Runtime ready."
      : label;
  updateControls();
}

function updateControls() {
  const available = state.ready && !state.busy;
  const opened = state.repository !== null;
  elements.repoId.disabled = state.busy;
  elements.openButton.disabled = !available;
  elements.initButton.disabled = !available;
  elements.commitButton.disabled = !available || !opened;
  elements.raceButton.disabled = !available || !opened;
  elements.reloadButton.disabled = !available || !opened;
  elements.resetButton.disabled = !available || !opened;
}

function renderState(repository) {
  state.repository = repository;
  if (repository === null) {
    elements.stateChip.textContent = "Not opened";
    elements.revision.textContent = "—";
    elements.objectCount.textContent = "—";
    elements.generation.textContent = "—";
    elements.generation.removeAttribute("title");
    elements.head.textContent = "—";
    elements.refsEmpty.hidden = false;
    elements.refsEmpty.textContent = "Initialize a repository to begin.";
    elements.refList.replaceChildren();
    elements.objectsEmpty.hidden = false;
    elements.objectList.replaceChildren();
    elements.rawState.textContent = "null";
    elements.objectPlaneCopy.textContent = "No repository opened";
    elements.controlPlaneCopy.textContent = "Revision —";
    updateControls();
    return;
  }

  const objects = Array.isArray(repository.objects) ? repository.objects : [];
  const refs = Object.entries(repository.refs ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  elements.stateChip.textContent = currentRepoId();
  elements.revision.textContent = String(repository.revision);
  elements.objectCount.textContent = String(objects.length);
  elements.generation.textContent = repository.generation.slice(0, 8);
  elements.generation.title = repository.generation;
  elements.head.textContent =
    repository.head?.kind === "symbolic"
      ? repository.head.target.replace("refs/heads/", "")
      : (repository.resolvedHeadOid?.slice(0, 8) ?? "unborn");
  elements.refsEmpty.hidden = refs.length > 0;
  elements.refsEmpty.textContent =
    "HEAD is unborn; main has not been published.";
  elements.refList.replaceChildren(
    ...refs.map(([name, oid]) => {
      const group = document.createElement("div");
      const term = document.createElement("dt");
      term.textContent = name;
      const value = document.createElement("dd");
      const code = document.createElement("code");
      code.textContent = oid;
      value.append(code);
      group.append(term, value);
      return group;
    }),
  );
  elements.objectsEmpty.hidden = objects.length > 0;
  elements.objectList.replaceChildren(
    ...objects.map((object) => {
      const item = document.createElement("li");
      const type = document.createElement("span");
      type.textContent = object.type;
      const oid = document.createElement("code");
      oid.textContent = object.oid;
      item.append(type, oid);
      return item;
    }),
  );
  elements.rawState.textContent = JSON.stringify(repository, null, 2);
  elements.objectPlaneCopy.textContent = `${objects.length} reachable object${objects.length === 1 ? "" : "s"}`;
  elements.controlPlaneCopy.textContent = `Revision ${repository.revision}`;
  localStorage.setItem("git-anywhere-demo-repo", currentRepoId());
  updateControls();
}

function renderRace(outcomes = null) {
  state.raceOutcomes = outcomes;
  if (outcomes === null) {
    elements.proofVerdict.textContent = "Not run";
    elements.proofVerdict.dataset.state = "idle";
    for (const [index, lane] of [...elements.writerLanes.children].entries()) {
      lane.dataset.outcome = "idle";
      lane.querySelector("strong").textContent = "—";
      lane.querySelector("small").textContent = "waiting";
      lane.querySelector("span").textContent =
        `Writer ${index === 0 ? "A" : "B"}`;
    }
    return;
  }

  elements.proofVerdict.textContent = "1 winner · 1 conflict";
  elements.proofVerdict.dataset.state = "passed";
  const byWriter = new Map(
    outcomes.map((outcome) => [outcome.writer, outcome]),
  );
  for (const [index, lane] of [...elements.writerLanes.children].entries()) {
    const writer = index === 0 ? "a" : "b";
    const outcome = byWriter.get(writer);
    lane.dataset.outcome =
      outcome.status === "fulfilled" ? "winner" : "conflict";
    lane.querySelector("strong").textContent =
      outcome.status === "fulfilled" ? "COMMITTED" : "REJECTED";
    lane.querySelector("small").textContent =
      outcome.status === "fulfilled"
        ? `revision ${outcome.result.revision}`
        : outcome.error.code;
  }
}

async function perform(label, command, onSuccess) {
  if (!elements.repoForm.reportValidity()) return;
  setNotice();
  setBusy(true, label);
  try {
    const result = await request(command, { repoId: currentRepoId() });
    await onSuccess(result);
  } catch (error) {
    const message = formatError(error);
    setNotice(message, "error");
    addEvent(message, "error");
  } finally {
    setBusy(false);
  }
}

elements.repoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  perform("Opening repository…", "open", ({ state: repository }) => {
    renderState(repository);
    renderRace();
    setNotice(
      `Opened ${currentRepoId()} at revision ${repository.revision}.`,
      "success",
    );
    addEvent(`Opened revision ${repository.revision}.`, "success");
  });
});

elements.initButton.addEventListener("click", () => {
  perform("Initializing repository…", "initialize", ({ state: repository }) => {
    renderState(repository);
    renderRace();
    setNotice(`Initialized ${currentRepoId()}; HEAD is unborn.`, "success");
    addEvent("Initialized a new bare repository.", "success");
  });
});

elements.commitButton.addEventListener("click", () => {
  perform(
    "Writing and verifying three objects…",
    "commit",
    ({ proof, state: repository }) => {
      renderState(repository);
      setNotice(
        `Published commit ${proof.commitOid} at revision ${proof.revision}.`,
        "success",
      );
      addEvent(
        `Published ${proof.commitOid.slice(0, 8)} at revision ${proof.revision}.`,
        "success",
      );
    },
  );
});

elements.raceButton.addEventListener("click", () => {
  perform(
    "Running two same-fence writers…",
    "race",
    ({ outcomes, state: repository }) => {
      renderState(repository);
      renderRace(outcomes);
      setNotice(
        "The transaction committed one writer and rejected the stale peer.",
        "success",
      );
      addEvent("Writer race passed: one commit, one CONFLICT.", "success");
    },
  );
});

elements.reloadButton.addEventListener("click", () => {
  sessionStorage.setItem(
    "git-anywhere-demo-reopen",
    JSON.stringify({
      repoId: currentRepoId(),
      runtimeId: state.runtimeId,
      expected: comparableState(state.repository),
      raceOutcomes: state.raceOutcomes,
    }),
  );
  location.reload();
});

elements.resetButton.addEventListener("click", () => {
  elements.resetRepoName.textContent = `“${currentRepoId()}”`;
  elements.resetDialog.returnValue = "";
  elements.resetDialog.showModal();
  elements.resetCancel.focus();
});

elements.resetDialog.addEventListener("close", () => {
  if (elements.resetDialog.returnValue !== "confirm") {
    elements.resetButton.focus();
    return;
  }
  perform("Resetting demo repository…", "reset", ({ deleted }) => {
    renderState(null);
    renderRace();
    setNotice(
      deleted
        ? "Reset complete. Immutable object bytes remain in OPFS."
        : "No repository metadata existed.",
      "success",
    );
    addEvent("Reset the demo-only repository state.", "success");
  });
});

elements.repoId.addEventListener("input", () => {
  if (state.repository !== null) {
    renderState(null);
    renderRace();
    setNotice("Repository ID changed. Open or initialize this ID to continue.");
  }
});

worker.addEventListener("message", ({ data }) => {
  if (data?.type === "response") {
    const waiter = pending.get(data.requestId);
    if (waiter === undefined) return;
    pending.delete(data.requestId);
    clearTimeout(waiter.timeout);
    if (data.ok) waiter.resolve(data.result);
    else waiter.reject(data.error);
    return;
  }
  if (data?.type === "boot-error") {
    elements.runtimeStatus.dataset.state = "failed";
    elements.runtimeStatusCopy.textContent = "Runtime failed";
    elements.actionStatus.textContent = "Build both WASM modules, then reload.";
    setNotice(formatError(data.error), "error");
    addEvent(formatError(data.error), "error");
    return;
  }
  if (data?.type !== "ready") return;
  state.ready = true;
  state.runtimeId = data.runtimeId;
  elements.runtimeStatus.dataset.state = "ready";
  elements.runtimeStatusCopy.textContent = data.dedicatedWorker
    ? "Dedicated Worker ready"
    : "Runtime ready";
  elements.actionStatus.textContent = "Runtime ready.";
  addEvent("Go-WASM, OpenDAL-WASM, OPFS, and IndexedDB are ready.", "success");
  updateControls();

  const reopenValue = sessionStorage.getItem("git-anywhere-demo-reopen");
  if (reopenValue !== null) {
    sessionStorage.removeItem("git-anywhere-demo-reopen");
    let reopen;
    try {
      reopen = JSON.parse(reopenValue);
    } catch {
      setNotice(
        "Reload proof data was invalid; open the repository manually.",
        "error",
      );
      return;
    }
    elements.repoId.value = reopen.repoId;
    perform(
      "Reopening after page + Worker reload…",
      "open",
      ({ state: repository }) => {
        const exactState =
          JSON.stringify(comparableState(repository)) ===
          JSON.stringify(reopen.expected);
        const newWorker = data.runtimeId !== reopen.runtimeId;
        if (!exactState || !newWorker) {
          throw new Error(
            "Reload proof failed: state changed or the Worker identity was reused",
          );
        }
        renderState(repository);
        renderRace(reopen.raceOutcomes ?? null);
        setNotice(
          `Passed: a new page and Worker reopened revision ${repository.revision} with identical HEAD and object bytes.`,
          "success",
        );
        addEvent(
          `Exact revision ${repository.revision} state reopened after reload.`,
          "success",
        );
      },
    );
  }
});

worker.addEventListener("error", (event) => {
  elements.runtimeStatus.dataset.state = "failed";
  elements.runtimeStatusCopy.textContent = "Worker failed";
  elements.actionStatus.textContent = "The dedicated Worker stopped.";
  setNotice(event.message, "error");
  addEvent(event.message, "error");
});

window.addEventListener("pagehide", () => worker.terminate(), { once: true });

elements.repoId.value =
  localStorage.getItem("git-anywhere-demo-repo") ?? "demo-repo";
renderState(null);
renderRace();
