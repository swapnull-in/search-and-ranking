/**
 * Zero-dependency static server for the interactive demo.
 *   npm run web            → serves web/ (tries PORT or 8080, then next free port)
 *   PORT=3000 npm run web  → start at a port you choose
 * Or skip this entirely: web/index.html is standalone — open it directly in a browser.
 */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize } from "node:path";

const ROOT = dirname(fileURLToPath(import.meta.url));
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2", ".mjs": "text/javascript" };

const server = createServer(async (req, res) => {
  // Strip query string, block path traversal, default to index.html.
  const path = normalize(decodeURIComponent((req.url ?? "/").split("?")[0])).replace(/^(\.\.[/\\])+/, "");
  const file = join(ROOT, path === "/" ? "index.html" : path);
  try {
    const body = await readFile(file);
    res.setHeader("content-type", TYPES[file.slice(file.lastIndexOf("."))] ?? "application/octet-stream");
    res.setHeader("cache-control", "no-store"); // always serve fresh during local dev
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end("Not found");
  }
});

let port = Number(process.env.PORT) || 8080;
const MAX_TRIES = 20;

server.on("error", (err) => {
  if (err.code === "EADDRINUSE" && port < (Number(process.env.PORT) || 8080) + MAX_TRIES) {
    console.log(`port ${port} in use, trying ${port + 1}…`);
    server.listen(++port);
  } else {
    console.error(err.message);
    process.exit(1);
  }
});

server.listen(port, () => console.log(`\n  open  http://localhost:${port}\n  (Ctrl-C to stop)\n`));
