import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { startDemoServer } from "./serve.mjs";

const DESKTOP_SCREENSHOT = "/tmp/git-anywhere-demo-desktop.png";
const MOBILE_SCREENSHOT = "/tmp/git-anywhere-demo-mobile.png";
const EXPECTED_OIDS = Object.freeze({
  blob: "9525eb55a829092df9a1ad6061dfbe4bda47ba41",
  tree: "12aafa50746d8b9d5e0375f526a4913e3d29bffd",
  commit: "894cc886e0bf70ba8f6f35e0f3750778e070ca50",
});

function serializeError(error) {
  return {
    name: error?.name ?? "Error",
    message: error?.message ?? String(error),
    ...(error?.details === undefined ? {} : { details: error.details }),
    ...(typeof error?.stack === "string" ? { stack: error.stack } : {}),
  };
}

async function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
  const cacheRoot = join(homedir(), "Library", "Caches", "ms-playwright");
  try {
    const entries = await readdir(cacheRoot, { withFileTypes: true });
    candidates.unshift(
      ...entries
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith("chromium_headless_shell-"),
        )
        .map((entry) =>
          join(
            cacheRoot,
            entry.name,
            "chrome-headless-shell-mac-arm64",
            "chrome-headless-shell",
          ),
        )
        .sort()
        .reverse(),
    );
  } catch {
    // Fall through to standard application paths.
  }
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("Chromium not found; set CHROMIUM_PATH to a Chromium binary");
}

function startChromium(binary, userDataDir, url) {
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-background-networking",
      "--disable-component-update",
      "--disable-default-apps",
      "--disable-sync",
      "--metrics-recording-only",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--window-size=1280,900",
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-32_768);
  });
  const debuggerUrl = new Promise((resolveDebugger, rejectDebugger) => {
    const timeout = setTimeout(
      () => rejectDebugger(new Error(`Chromium DevTools timeout\n${stderr}`)),
      15_000,
    );
    function inspect() {
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match === null) return;
      clearTimeout(timeout);
      child.stderr.off("data", inspect);
      resolveDebugger(match[1]);
    }
    child.stderr.on("data", inspect);
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectDebugger(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      rejectDebugger(
        new Error(
          `Chromium exited before DevTools (${code ?? signal})\n${stderr}`,
        ),
      );
    });
  });
  return { child, debuggerUrl, stderr: () => stderr };
}

async function findPageTarget(browserDebuggerUrl, expectedUrl) {
  const base = browserDebuggerUrl
    .replace(/^ws:/, "http:")
    .replace(/\/devtools\/browser\/.*$/, "");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const targets = await (await fetch(`${base}/json/list`)).json();
    const page = targets.find(
      (target) => target.type === "page" && target.url.startsWith(expectedUrl),
    );
    if (page !== undefined) return page.webSocketDebuggerUrl;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Chromium page target did not appear");
}

function connectCdp(webSocketUrl) {
  return new Promise((resolveConnection, rejectConnection) => {
    if (typeof WebSocket !== "function") {
      rejectConnection(new Error("Node.js global WebSocket is unavailable"));
      return;
    }
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Set();
    socket.addEventListener(
      "error",
      () => rejectConnection(new Error("CDP WebSocket failed")),
      { once: true },
    );
    socket.addEventListener(
      "open",
      () => {
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.id !== undefined) {
            const waiter = pending.get(message.id);
            if (waiter === undefined) return;
            pending.delete(message.id);
            if (message.error !== undefined) {
              waiter.reject(new Error(message.error.message));
            } else {
              waiter.resolve(message.result);
            }
            return;
          }
          for (const listener of listeners) listener(message);
        });
        resolveConnection({
          send(method, params = {}) {
            const id = nextId++;
            socket.send(JSON.stringify({ id, method, params }));
            return new Promise((resolveRequest, rejectRequest) => {
              pending.set(id, {
                resolve: resolveRequest,
                reject: rejectRequest,
              });
            });
          },
          onEvent(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close() {
            socket.close();
          },
        });
      },
      { once: true },
    );
  });
}

async function stopChromium(process) {
  const child = process.child;
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  child.kill("SIGTERM");
  const exit = await Promise.race([
    new Promise((resolveExit) =>
      child.once("exit", (code, signal) => resolveExit({ code, signal })),
    ),
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout({ timeout: true }), 10_000),
    ),
  ]);
  if (!exit.timeout) return exit;
  child.kill("SIGKILL");
  return new Promise((resolveExit) =>
    child.once("exit", (code, signal) => resolveExit({ code, signal })),
  );
}

function remoteDescription(remote) {
  if (remote.type === "object") {
    const properties = Object.fromEntries(
      (remote.value ?? []).map(({ name, value }) => [name, value?.value]),
    );
    return (
      properties.message ??
      properties.description ??
      properties.name ??
      "object"
    );
  }
  return remote.value ?? remote.description ?? remote.type;
}

function createBrowserDriver(cdp, diagnostics) {
  let loadGeneration = 0;
  let lifecycleGeneration = 0;
  cdp.onEvent((event) => {
    switch (event.method) {
      case "Page.loadEventFired":
        loadGeneration += 1;
        break;
      case "Page.lifecycleEvent":
        if (event.params.name === "networkIdle") lifecycleGeneration += 1;
        break;
      case "Runtime.consoleAPICalled":
        if (["error", "assert"].includes(event.params.type)) {
          diagnostics.consoleErrors.push(
            event.params.args.map(remoteDescription).join(" "),
          );
        }
        break;
      case "Runtime.exceptionThrown":
        diagnostics.runtimeErrors.push(
          event.params.exceptionDetails.exception?.description ??
            event.params.exceptionDetails.text,
        );
        break;
      case "Log.entryAdded":
        if (event.params.entry.level === "error") {
          diagnostics.logErrors.push(event.params.entry.text);
        }
        break;
    }
  });

  async function evaluate(expression, awaitPromise = true) {
    const response = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue: true,
      userGesture: true,
    });
    if (response.exceptionDetails !== undefined) {
      const description =
        response.exceptionDetails.exception?.description ??
        response.exceptionDetails.text;
      throw new Error(`Browser evaluation failed: ${description}`);
    }
    return response.result.value;
  }

  async function waitFor(expression, description, timeoutMs = 90_000) {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    throw new Error(
      `Timed out waiting for ${description}; last value: ${JSON.stringify(last)}`,
    );
  }

  return {
    evaluate,
    waitFor,
    get loadGeneration() {
      return loadGeneration;
    },
    get lifecycleGeneration() {
      return lifecycleGeneration;
    },
  };
}

async function click(driver, selector) {
  await driver.evaluate(
    `document.querySelector(${JSON.stringify(selector)}).click()`,
  );
}

async function clickAndWaitIdle(driver, selector, description) {
  await click(driver, selector);
  await driver.waitFor(
    `(() => {
      const console = document.querySelector("#repository-console");
      return console?.getAttribute("aria-busy") === "false" &&
        document.querySelector("#action-status")?.textContent === "Runtime ready.";
    })()`,
    description,
  );
}

async function clickDialogActionAndWaitIdle(driver, selector, description) {
  await driver.evaluate(`(() => {
    const dialog = document.querySelector("#reset-dialog");
    const button = document.querySelector(${JSON.stringify(selector)});
    dialog.close(button.value);
  })()`);
  await driver.waitFor(
    `!document.querySelector("#reset-dialog")?.open &&
      document.querySelector("#repository-console")?.getAttribute("aria-busy") === "false" &&
      document.querySelector("#action-status")?.textContent === "Runtime ready." &&
      document.querySelector("#raw-state")?.textContent === "null"`,
    description,
  );
}

async function repositoryState(driver) {
  const raw = await driver.evaluate(
    `document.querySelector("#raw-state")?.textContent ?? "null"`,
  );
  return JSON.parse(raw);
}

function comparableState(repository) {
  return {
    generation: repository.generation,
    revision: repository.revision,
    head: repository.head,
    resolvedHeadOid: repository.resolvedHeadOid ?? "",
    refs: repository.refs ?? {},
    objects: (repository.objects ?? []).map(({ type, oid, base64 }) => ({
      type,
      oid,
      base64,
    })),
  };
}

async function assertNoOverflow(driver, width, height) {
  await driver.evaluate(
    `document.documentElement.style.scrollBehavior = "auto"`,
  );
  await driver.evaluate(`window.scrollTo(0, 0)`);
  const viewport = await driver.evaluate(`({
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth
  })`);
  assert.equal(
    viewport.innerWidth,
    width,
    `viewport width did not become ${width}`,
  );
  assert.ok(
    viewport.scrollWidth <= width && viewport.bodyScrollWidth <= width,
    `horizontal overflow at ${width}x${height}: ${JSON.stringify(viewport)}`,
  );
  return viewport;
}

async function setViewport(cdp, width, height) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
    screenWidth: width,
    screenHeight: height,
  });
}

async function pressEscape(cdp) {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

async function screenshot(cdp, path) {
  const metrics = await cdp.send("Page.getLayoutMetrics");
  const size = metrics.cssContentSize ?? metrics.contentSize;
  const capture = await cdp.send("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    fromSurface: true,
    clip: {
      x: 0,
      y: 0,
      width: Math.ceil(size.width),
      height: Math.ceil(size.height),
      scale: 1,
    },
  });
  await writeFile(path, Buffer.from(capture.data, "base64"));
}

const server = await startDemoServer(0);
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const pageUrl = `${origin}/demo/`;
const profile = await mkdtemp(join(tmpdir(), "git-anywhere-demo-profile-"));
let chromium;
let cdp;

try {
  const binary = await findChromium();
  chromium = startChromium(binary, profile, pageUrl);
  const browserDebuggerUrl = await chromium.debuggerUrl;
  const pageDebuggerUrl = await findPageTarget(browserDebuggerUrl, pageUrl);
  cdp = await connectCdp(pageDebuggerUrl);
  const diagnostics = { consoleErrors: [], runtimeErrors: [], logErrors: [] };
  const driver = createBrowserDriver(cdp, diagnostics);

  await Promise.all([
    cdp.send("Page.enable"),
    cdp.send("Runtime.enable"),
    cdp.send("Log.enable"),
    cdp.send("Page.setLifecycleEventsEnabled", { enabled: true }),
    cdp.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" }),
    cdp.send("Emulation.setLocaleOverride", { locale: "en-US" }),
    cdp.send("Emulation.setEmulatedMedia", {
      media: "screen",
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    }),
  ]);
  await setViewport(cdp, 1280, 900);

  await driver.waitFor(
    `document.querySelector("#runtime-status")?.dataset.state === "ready"`,
    "the demo Worker and WASM runtimes",
  );
  await driver.waitFor(
    `document.readyState === "complete"`,
    "the initial page load",
  );
  await assertNoOverflow(driver, 1280, 900);

  const semantics = await driver.evaluate(`(() => ({
    title: document.querySelector("h1")?.textContent.trim(),
    main: Boolean(document.querySelector("main#demo")),
    inputLabel: document.querySelector('label[for="repo-id"]')?.textContent.trim(),
    dialogLabel: document.querySelector("#reset-dialog")?.getAttribute("aria-labelledby"),
    statusLive: document.querySelector("#action-status")?.getAttribute("aria-live"),
    buttonNames: [...document.querySelectorAll("button")].map((button) => button.textContent.trim())
  }))()`);
  assert.ok(semantics.title?.includes("Publish a commit"));
  assert.equal(semantics.main, true);
  assert.equal(semantics.inputLabel, "Repository ID");
  assert.equal(semantics.dialogLabel, "reset-dialog-title");
  assert.equal(semantics.statusLive, "polite");
  assert.ok(
    semantics.buttonNames.some((name) => name.includes("Initialize new")),
  );

  const repoId = `demo-browser-test-${process.pid}`;
  await driver.evaluate(`(() => {
    const input = document.querySelector("#repo-id");
    input.value = ${JSON.stringify(repoId)};
    input.dispatchEvent(new Event("input", { bubbles: true }));
  })()`);
  await clickAndWaitIdle(driver, "#init-button", "repository initialization");
  const initial = await repositoryState(driver);
  assert.equal(initial.revision, 0);
  assert.deepEqual(initial.refs, {});
  assert.deepEqual(initial.objects, []);
  assert.deepEqual(initial.head, {
    kind: "symbolic",
    target: "refs/heads/main",
  });
  assert.ok(
    typeof initial.generation === "string" && initial.generation.length > 0,
  );

  await clickAndWaitIdle(
    driver,
    "#commit-button",
    "deterministic proof commit",
  );
  const committed = await repositoryState(driver);
  assert.equal(committed.revision, 1);
  assert.equal(committed.resolvedHeadOid, EXPECTED_OIDS.commit);
  assert.equal(committed.refs["refs/heads/main"], EXPECTED_OIDS.commit);
  assert.deepEqual(
    Object.fromEntries(committed.objects.map(({ type, oid }) => [type, oid])),
    EXPECTED_OIDS,
  );

  await clickAndWaitIdle(driver, "#race-button", "same-fence writer race");
  const raced = await repositoryState(driver);
  assert.equal(raced.revision, 2);
  const raceUi = await driver.evaluate(`(() => ({
    verdict: document.querySelector("#proof-verdict")?.textContent.trim(),
    outcomes: [...document.querySelectorAll("#writer-lanes .writer-lane")].map((lane) => ({
      outcome: lane.dataset.outcome,
      result: lane.querySelector("strong")?.textContent.trim(),
      detail: lane.querySelector("small")?.textContent.trim()
    }))
  }))()`);
  assert.equal(raceUi.verdict, "1 winner · 1 conflict");
  assert.deepEqual(raceUi.outcomes.map(({ outcome }) => outcome).sort(), [
    "conflict",
    "winner",
  ]);
  assert.equal(
    raceUi.outcomes.find(({ outcome }) => outcome === "conflict").detail,
    "CONFLICT",
  );
  assert.equal(
    raceUi.outcomes.find(({ outcome }) => outcome === "winner").detail,
    "revision 2",
  );

  const beforeReload = comparableState(raced);
  const beforeLoadGeneration = driver.loadGeneration;
  await click(driver, "#reload-button");
  await driver.waitFor(
    `document.querySelector("#runtime-status")?.dataset.state === "ready" &&
      document.querySelector("#notice")?.textContent.includes("new page and Worker reopened revision 2")`,
    "the reload and new-Worker reopen proof",
  );
  assert.ok(
    driver.loadGeneration > beforeLoadGeneration,
    "Reload did not navigate the page",
  );
  const reopened = await repositoryState(driver);
  assert.deepEqual(comparableState(reopened), beforeReload);

  await setViewport(cdp, 1280, 900);
  const desktopViewport = await assertNoOverflow(driver, 1280, 900);
  await screenshot(cdp, DESKTOP_SCREENSHOT);
  await setViewport(cdp, 390, 844);
  const longRepoId = `r${"a".repeat(127)}`;
  const originalRenderedId = await driver.evaluate(`(() => {
    const input = document.querySelector("#repo-id");
    const chip = document.querySelector("#state-chip");
    const original = { input: input.value, chip: chip.textContent };
    input.value = ${JSON.stringify(longRepoId)};
    chip.textContent = ${JSON.stringify(longRepoId)};
    return original;
  })()`);
  const mobileViewport = await assertNoOverflow(driver, 390, 844);
  await screenshot(cdp, MOBILE_SCREENSHOT);
  await driver.evaluate(`(() => {
    document.querySelector("#repo-id").value = ${JSON.stringify(repoId)};
    document.querySelector("#state-chip").textContent = ${JSON.stringify(repoId)};
  })()`);
  assert.deepEqual(originalRenderedId, { input: repoId, chip: repoId });
  await setViewport(cdp, 1280, 900);

  await click(driver, "#reset-button");
  const dialogOpened = await driver.evaluate(`(() => ({
    open: document.querySelector("#reset-dialog")?.open,
    active: document.activeElement?.id,
    modal: document.querySelector("#reset-dialog")?.matches(":modal")
  }))()`);
  assert.deepEqual(dialogOpened, {
    open: true,
    active: "reset-cancel",
    modal: true,
  });
  await pressEscape(cdp);
  await driver.waitFor(
    `!document.querySelector("#reset-dialog")?.open`,
    "Escape to close the reset dialog",
  );
  await driver.waitFor(
    `document.activeElement?.id === "reset-button"`,
    "cancelled reset focus restoration",
  );
  assert.deepEqual(
    comparableState(await repositoryState(driver)),
    beforeReload,
  );

  await click(driver, "#reset-button");
  assert.equal(
    await driver.evaluate(`document.activeElement?.id`),
    "reset-cancel",
  );
  await clickDialogActionAndWaitIdle(
    driver,
    "#reset-confirm",
    "metadata-only demo reset",
  );
  assert.equal(
    await driver.evaluate(`document.querySelector("#raw-state")?.textContent`),
    "null",
  );
  assert.ok(
    (
      await driver.evaluate(`document.querySelector("#notice")?.textContent`)
    ).includes("Immutable object bytes remain in OPFS"),
  );

  await clickAndWaitIdle(
    driver,
    "#open-button",
    "post-reset missing-repository proof",
  );
  const postResetError = await driver.evaluate(
    `document.querySelector("#notice")?.textContent`,
  );
  assert.match(
    postResetError,
    /REPOSITORY_NOT_FOUND|metadata is missing|does not exist/i,
  );

  assert.deepEqual(diagnostics, {
    consoleErrors: [],
    runtimeErrors: [],
    logErrors: [],
  });

  console.log(
    JSON.stringify({
      ok: true,
      chromium: basename(binary),
      repoId,
      lifecycle: {
        initializedRevision: initial.revision,
        committedRevision: committed.revision,
        racedRevision: raced.revision,
        reloadNavigation: true,
        exactStateReopen: true,
        metadataReset: true,
      },
      oids: EXPECTED_OIDS,
      race: raceUi,
      accessibility: {
        semanticMain: semantics.main,
        labelledRepositoryInput: semantics.inputLabel === "Repository ID",
        modalDialog: dialogOpened.modal,
        cancelInitialFocus: dialogOpened.active === "reset-cancel",
        cancelRestoredFocus: true,
      },
      responsive: {
        desktop: desktopViewport,
        mobile: mobileViewport,
        maxLengthRepositoryId: longRepoId.length,
      },
      screenshots: {
        desktop: DESKTOP_SCREENSHOT,
        mobile: MOBILE_SCREENSHOT,
      },
      diagnostics,
    }),
  );
} catch (error) {
  if (chromium !== undefined) {
    error.details = {
      ...(error.details ?? {}),
      chromiumStderr: chromium.stderr(),
    };
  }
  console.error(JSON.stringify({ ok: false, error: serializeError(error) }));
  process.exitCode = 1;
} finally {
  cdp?.close();
  if (chromium !== undefined) await stopChromium(chromium);
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profile, { recursive: true, force: true });
}
