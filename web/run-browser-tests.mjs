import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)));
const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
]);

async function findChromium() {
  if (process.env.CHROMIUM_PATH) {
    return process.env.CHROMIUM_PATH;
  }
  const cacheRoot = join(homedir(), "Library", "Caches", "ms-playwright");
  const candidates = [];
  for (const entry of await readdir(cacheRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith("chromium_headless_shell-")) {
      continue;
    }
    candidates.push(
      join(
        cacheRoot,
        entry.name,
        "chrome-headless-shell-mac-arm64",
        "chrome-headless-shell",
      ),
    );
  }
  candidates.sort().reverse();
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) {
        return candidate;
      }
    } catch {
      // Try the next installed Playwright browser.
    }
  }
  throw new Error("Chromium not found; set CHROMIUM_PATH to a headless browser");
}

function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const requested = url.pathname === "/" ? "browser-tests.html" : url.pathname.slice(1);
      const path = resolve(root, requested);
      if (path !== root && !path.startsWith(`${root}/`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        "content-type": mimeTypes.get(extname(path)) ?? "application/octet-stream",
        "cache-control": "no-store",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500).end(error.message);
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function startChromium(binary, userDataDir, url) {
  const child = spawn(
    binary,
    [
      "--headless=new",
      "--disable-gpu",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      url,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  child.stderr.setEncoding("utf8");
  const debuggerUrl = new Promise((resolveDebugger, rejectDebugger) => {
    let stderr = "";
    const timeout = setTimeout(
      () => rejectDebugger(new Error(`Chromium DevTools timeout\n${stderr}`)),
      10_000,
    );
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match !== null) {
        clearTimeout(timeout);
        resolveDebugger(match[1]);
      }
    });
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
  return { child, debuggerUrl };
}

async function findPageTarget(browserDebuggerUrl, expectedUrl) {
  const base = browserDebuggerUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targets = await (await fetch(`${base}/json/list`)).json();
    const page = targets.find(
      (target) => target.type === "page" && target.url.startsWith(expectedUrl),
    );
    if (page !== undefined) {
      return page.webSocketDebuggerUrl;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Chromium page target did not appear");
}

function connectCdp(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    let nextId = 1;
    const pending = new Map();
    socket.addEventListener("error", () => reject(new Error("CDP WebSocket failed")), {
      once: true,
    });
    socket.addEventListener(
      "open",
      () => {
        socket.addEventListener("message", (event) => {
          const message = JSON.parse(event.data);
          if (message.id === undefined) {
            return;
          }
          const waiter = pending.get(message.id);
          if (waiter === undefined) {
            return;
          }
          pending.delete(message.id);
          if (message.error !== undefined) {
            waiter.reject(new Error(message.error.message));
          } else {
            waiter.resolve(message.result);
          }
        });
        resolve({
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await cdp.evaluate(`(() => ({
        status: document.body?.dataset.status,
        result: document.querySelector('#results')?.textContent
      }))()`);
      const value = response.result?.value;
      if (value?.status === "passed" || value?.status === "failed") {
        return value;
      }
    } catch {
      // A real page reload briefly destroys the execution context.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Browser contract timed out");
}

const server = await startServer();
const address = server.address();
const profile = await mkdtemp(join(tmpdir(), "git-metadata-browser-test-"));
try {
  const chromium = await findChromium();
  const url = `http://127.0.0.1:${address.port}/browser-tests.html?run=${Date.now()}`;
  const chromiumProcess = startChromium(chromium, profile, url);
  let cdp;
  try {
    const browserDebuggerUrl = await chromiumProcess.debuggerUrl;
    const pageDebuggerUrl = await findPageTarget(browserDebuggerUrl, url);
    cdp = await connectCdp(pageDebuggerUrl);
    const outcome = await awaitBrowserResult(cdp);
    if (outcome.status !== "passed") {
      console.error(outcome.result);
      process.exitCode = 1;
    } else {
      console.log(outcome.result);
    }
  } finally {
    cdp?.close();
    chromiumProcess.child.kill("SIGTERM");
    await new Promise((resolveExit) => {
      if (chromiumProcess.child.exitCode !== null) {
        resolveExit();
        return;
      }
      chromiumProcess.child.once("exit", resolveExit);
    });
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
