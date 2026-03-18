// Minimal static server for Cloud Run buildpacks.
// Serves files from this folder on the port provided by Cloud Run.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8080;
const ROOT = __dirname;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml; charset=utf-8",
  ".ico": "image/x-icon"
};

function safeResolve(urlPath) {
  const clean = decodeURIComponent(urlPath.split("?")[0]);
  const normalized = path.posix.normalize(clean).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(ROOT, normalized);
  if (!filePath.startsWith(ROOT)) return null;
  return filePath;
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

const server = http.createServer((req, res) => {
  const reqPath = req.url === "/" ? "/index.html" : req.url;
  const filePath = safeResolve(reqPath);
  if (!filePath) return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "Bad request");

  // If a directory is requested, default to index.html
  let finalPath = filePath;
  try {
    if (fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory()) {
      finalPath = path.join(finalPath, "index.html");
    }
  } catch (_) {}

  fs.readFile(finalPath, (err, data) => {
    if (err) {
      // SPA-ish fallback: if someone hits /main.html etc, that's a real file.
      // Otherwise, fallback to index.html if present.
      const fallback = path.join(ROOT, "index.html");
      if (finalPath !== fallback && fs.existsSync(fallback)) {
        const ext = path.extname(fallback).toLowerCase();
        return send(res, 200, { "Content-Type": MIME[ext] || "text/html; charset=utf-8" }, fs.readFileSync(fallback));
      }
      return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "Not Found");
    }
    const ext = path.extname(finalPath).toLowerCase();
    send(res, 200, { "Content-Type": MIME[ext] || "application/octet-stream" }, data);
  });
});

server.listen(PORT, () => {
  console.log(`PasaLista listening on port ${PORT}`);
});

