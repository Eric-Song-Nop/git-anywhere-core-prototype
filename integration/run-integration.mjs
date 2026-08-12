import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const integrationRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(integrationRoot, "..");
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);

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
    const installed = entries
      .filter(
        (entry) => entry.isDirectory() && entry.name.startsWith("chromium_headless_shell-"),
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
      .reverse();
    candidates.unshift(...installed);
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
  throw new Error("Chromium not found; set CHROMIUM_PATH to a headless Chromium binary");
}

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const requested =
        url.pathname === "/"
          ? "integration/index.html"
          : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const path = resolve(projectRoot, requested);
      if (path !== projectRoot && !path.startsWith(`${projectRoot}${sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        "content-type": mimeTypes.get(extname(path)) ?? "application/octet-stream",
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.message);
    }
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once("error", rejectServer);
    // Port zero selects one free port once. The same server remains alive, so
    // both fresh Chromium processes use the exact same localhost origin.
    server.listen(0, "127.0.0.1", () => resolveServer(server));
  });
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
      // Match the accumulated buffer because Chromium may split the DevTools
      // announcement across stderr chunks.
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
        new Error(`Chromium exited before DevTools (${code ?? signal})\n${stderr}`),
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
          if (message.id === undefined) return;
          const waiter = pending.get(message.id);
          if (waiter === undefined) return;
          pending.delete(message.id);
          if (message.error !== undefined) waiter.reject(new Error(message.error.message));
          else waiter.resolve(message.result);
        });
        resolveConnection({
          evaluate(expression) {
            const id = nextId++;
            socket.send(
              JSON.stringify({
                id,
                method: "Runtime.evaluate",
                params: { expression, returnByValue: true },
              }),
            );
            return new Promise((resolveRequest, rejectRequest) => {
              pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
            });
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

async function awaitBrowserResult(cdp) {
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const response = await cdp.evaluate(`(() => ({
      status: document.body?.dataset.status,
      result: document.querySelector('#result')?.textContent
    }))()`);
    const value = response.result?.value;
    if (value?.status === "passed" || value?.status === "failed") return value;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("browser integration phase timed out");
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
  if (exit.timeout) {
    child.kill("SIGKILL");
    return new Promise((resolveExit) =>
      child.once("exit", (code, signal) => resolveExit({ code, signal })),
    );
  }
  return exit;
}

async function runBrowserPhase(binary, profile, origin, repoId, runId, phase) {
  const url = `${origin}/integration/index.html?phase=${phase}&repoId=${encodeURIComponent(repoId)}&run=${encodeURIComponent(runId)}`;
  const chromium = startChromium(binary, profile, url);
  const pid = chromium.child.pid;
  let cdp;
  try {
    const browserDebuggerUrl = await chromium.debuggerUrl;
    const pageDebuggerUrl = await findPageTarget(browserDebuggerUrl, url);
    cdp = await connectCdp(pageDebuggerUrl);
    const outcome = await awaitBrowserResult(cdp);
    let payload;
    try {
      payload = JSON.parse(outcome.result);
    } catch (error) {
      throw new Error(`browser returned non-JSON result: ${outcome.result}`, { cause: error });
    }
    if (outcome.status !== "passed" || payload.ok !== true) {
      const error = new Error(`browser ${phase} failed: ${JSON.stringify(payload)}`);
      error.details = payload;
      throw error;
    }
    return { pid, payload };
  } catch (error) {
    error.details = { ...(error.details ?? {}), chromiumStderr: chromium.stderr() };
    throw error;
  } finally {
    cdp?.close();
    const exit = await stopChromium(chromium);
    if (exit.timeout) throw new Error(`Chromium ${pid} could not be stopped`);
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectCommand);
    child.once("exit", (code, signal) => {
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code === 0) resolveCommand(result);
      else {
        const error = new Error(
          `${command} ${args.join(" ")} failed (${code ?? signal}): ${result.stderr}`,
        );
        error.details = result;
        rejectCommand(error);
      }
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input);
  });
}

function normalizedState(state) {
  return {
    generation: state.generation,
    revision: state.revision,
    head: state.head,
    resolvedHeadOid: state.resolvedHeadOid,
    refs: Object.fromEntries(Object.entries(state.refs).sort(([a], [b]) => a.localeCompare(b))),
    objects: [...state.objects]
      .map((object) => ({ type: object.type, oid: object.oid, base64: object.base64 }))
      .sort((a, b) => a.oid.localeCompare(b.oid)),
  };
}

async function runCanonicalGitOracle(state) {
  const temporary = await mkdtemp(join(tmpdir(), "git-anywhere-oracle-"));
  const gitDir = join(temporary, "oracle.git");
  try {
    const gitVersion = (await runCommand("git", ["--version"])).stdout.trim();
    await runCommand("git", ["init", "--bare", gitDir]);
    const objects = [];
    for (const object of state.objects) {
      const actual = (
        await runCommand(
          "git",
          ["--git-dir", gitDir, "hash-object", "-w", "-t", object.type, "--stdin"],
          { input: Buffer.from(object.base64, "base64") },
        )
      ).stdout.trim();
      assert.equal(actual, object.oid, `canonical Git hash mismatch for ${object.oid}`);
      objects.push({ type: object.type, expectedOid: object.oid, actualOid: actual });
    }

    for (const [name, oid] of Object.entries(state.refs).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      await runCommand("git", ["--git-dir", gitDir, "update-ref", name, oid]);
    }
    if (state.head.kind === "symbolic") {
      await runCommand("git", ["--git-dir", gitDir, "symbolic-ref", "HEAD", state.head.target]);
    } else {
      await runCommand("git", [
        "--git-dir",
        gitDir,
        "update-ref",
        "--no-deref",
        "HEAD",
        state.head.oid,
      ]);
    }

    const fsck = await runCommand("git", [
      "--git-dir",
      gitDir,
      "fsck",
      "--full",
      "--strict",
    ]);
    const head = (
      await runCommand("git", ["--git-dir", gitDir, "rev-parse", "HEAD"])
    ).stdout.trim();
    assert.equal(head, state.resolvedHeadOid, "canonical Git resolved a different HEAD");
    const headType = (
      await runCommand("git", ["--git-dir", gitDir, "cat-file", "-t", "HEAD"])
    ).stdout.trim();
    assert.equal(headType, "commit", "canonical Git did not decode HEAD as a commit");
    const treePaths = (
      await runCommand("git", ["--git-dir", gitDir, "ls-tree", "-r", "--name-only", "HEAD"])
    ).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    assert.deepEqual(treePaths, ["proof.txt"], "canonical Git decoded an unexpected tree");
    const proof = (
      await runCommand("git", ["--git-dir", gitDir, "show", "HEAD:proof.txt"])
    ).stdout;
    assert.equal(proof, "git-anywhere core proof\n", "canonical Git decoded wrong blob bytes");

    return {
      ok: true,
      gitVersion,
      objects,
      fsck: { stdout: fsck.stdout.trim(), stderr: fsck.stderr.trim() },
      head,
      headType,
      treePaths,
      proofBase64: Buffer.from(proof).toString("base64"),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

const server = await startServer();
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const profile = await mkdtemp(join(tmpdir(), "git-anywhere-integration-profile-"));
try {
  const chromium = await findChromium();
  const chromiumVersion = (await runCommand(chromium, ["--version"])).stdout.trim();
  const runId = `${Date.now()}-${process.pid}`;
  const repoId = `integration-${runId}`;
  const phase1 = await runBrowserPhase(chromium, profile, origin, repoId, runId, "phase1");
  const phase2 = await runBrowserPhase(chromium, profile, origin, repoId, runId, "phase2");

  assert.notEqual(phase1.pid, phase2.pid, "persistence phases reused one Chromium process");
  assert.equal(phase1.payload.dedicatedWorker, true, "phase1 did not run in a Worker");
  assert.equal(phase2.payload.dedicatedWorker, true, "phase2 did not run in a Worker");
  assert.deepEqual(
    normalizedState(phase2.payload.state),
    normalizedState(phase1.payload.state),
    "state changed across complete Chromium restart",
  );

  const oracle = await runCanonicalGitOracle(phase2.payload.state);
  const result = {
    ok: true,
    origin,
    chromium: basename(chromium),
    chromiumVersion,
    processRestart: {
      sequentialProcesses: true,
      distinctPids: phase1.pid !== phase2.pid,
      phase1Pid: phase1.pid,
      phase2Pid: phase2.pid,
      sameUserDataDirectory: true,
      sameOrigin: true,
    },
    exactStateReopen: true,
    phase1: phase1.payload,
    phase2: phase2.payload,
    canonicalGitOracle: oracle,
  };
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(JSON.stringify({ ok: false, error: serializeError(error) }));
  process.exitCode = 1;
} finally {
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profile, { recursive: true, force: true });
}
