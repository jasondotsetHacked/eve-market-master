#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { loadEnv, jsonResponse } from "./lib.mjs";

await loadEnv();

const port = Number(process.env.PORT || 8787);
const root = process.cwd();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === "/dev-api/config") {
      return jsonResponse(res, 200, {
        clientId: process.env.EVE_CLIENT_ID || "",
        redirectUri: process.env.EVE_REDIRECT_URI || `http://localhost:${port}/development/sso/`,
        scopes: process.env.EVE_SCOPES || "esi-markets.read_character_orders.v1 esi-wallet.read_character_wallet.v1"
      });
    }

    if (url.pathname === "/dev-api/token" && req.method === "POST") {
      return proxyToken(req, res);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    jsonResponse(res, 500, { error: error.message });
  }
});

server.listen(port, () => {
  console.log(`EVE Market Master dev server: http://localhost:${port}/app/`);
  console.log(`SSO test page: http://localhost:${port}/development/sso/`);
});

async function serveStatic(pathname, res) {
  const requestPath = pathname === "/" ? "/app/" : pathname;
  const candidate = resolve(root, `.${decodeURIComponent(requestPath)}`);
  if (!candidate.startsWith(root)) return notFound(res);

  let filePath = candidate;
  const fileStat = await stat(filePath).catch(() => null);
  if (fileStat?.isDirectory()) filePath = join(filePath, "index.html");

  const finalPath = normalize(filePath);
  const body = await readFile(finalPath).catch(() => null);
  if (!body) return notFound(res);

  res.writeHead(200, { "content-type": contentType(extname(finalPath)) });
  res.end(body);
}

async function proxyToken(req, res) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const payload = Buffer.concat(chunks).toString("utf8");

  const response = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: payload
  });

  const text = await response.text();
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") || "application/json"
  });
  res.end(text);
}

function notFound(res) {
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("Not found");
}

function contentType(extension) {
  return {
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml"
  }[extension] || "application/octet-stream";
}
