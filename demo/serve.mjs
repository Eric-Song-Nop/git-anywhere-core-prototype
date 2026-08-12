import { createServer } from "node:http";
import { access, readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const demoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));
const projectRoot = resolve(demoRoot, "..");
const mimeTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".wasm", "application/wasm"],
]);
const publicPaths = new Set([
  "demo/app.js",
  "demo/git-object-view.js",
  "demo/index.html",
  "demo/styles.css",
  "demo/worker.js",
  "go-git/git-core.wasm",
  "go-git/loader.js",
  "go-git/wasm_exec.js",
  "rust-opendal/bridge.js",
  "rust-opendal/pkg/git_object_store.js",
  "rust-opendal/pkg/git_object_store_bg.wasm",
  "rust-opendal/worker-compat.js",
  "web/git-metadata-store.js",
]);

export function createDemoServer() {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      const pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const requested =
        pathname === ""
          ? "demo/index.html"
          : pathname.endsWith("/")
            ? `${pathname}index.html`
            : pathname;
      if (!publicPaths.has(requested)) {
        response.writeHead(404).end("not found");
        return;
      }
      const path = resolve(projectRoot, requested);
      if (path !== projectRoot && !path.startsWith(`${projectRoot}${sep}`)) {
        response.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile(path);
      response.writeHead(200, {
        "content-type":
          mimeTypes.get(extname(path)) ?? "application/octet-stream",
        "cache-control": "no-store",
        "cross-origin-resource-policy": "same-origin",
      });
      response.end(body);
    } catch (error) {
      response
        .writeHead(error.code === "ENOENT" ? 404 : 500)
        .end(error.message);
    }
  });
}

export async function startDemoServer(port = 0) {
  for (const generated of [
    "go-git/git-core.wasm",
    "go-git/wasm_exec.js",
    "rust-opendal/pkg/git_object_store.js",
    "rust-opendal/pkg/git_object_store_bg.wasm",
  ]) {
    try {
      await access(resolve(projectRoot, generated));
    } catch {
      throw new Error(
        `Missing ${generated}. Run ./rust-opendal/scripts/build.sh and ./go-git/scripts/build.sh first.`,
      );
    }
  }
  const server = createDemoServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, "127.0.0.1", resolveListen);
  });
  return server;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const requestedPort = Number.parseInt(process.env.PORT ?? "4173", 10);
  if (
    !Number.isInteger(requestedPort) ||
    requestedPort < 0 ||
    requestedPort > 65535
  ) {
    throw new Error("PORT must be an integer from 0 through 65535");
  }
  const server = await startDemoServer(requestedPort);
  const address = server.address();
  console.log(
    `Git Anywhere Storage Lab: http://127.0.0.1:${address.port}/demo/`,
  );
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
