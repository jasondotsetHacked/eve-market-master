#!/usr/bin/env node
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadEnv, jsonResponse } from "./lib.mjs";
import { characterIdFromClaims, decodeJwtPayload, readLocalToken, summarizeToken } from "./esi/token-store.mjs";
import { attachHubMarket, buildWatchlist, fetchTransactions, HUBS, loadMarketTypes } from "./esi/market-analysis.mjs";

await loadEnv();

const port = Number(process.env.PORT || 8787);
const root = process.cwd();
const sessions = new Map();
const pendingStates = new Map();

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

    if (url.pathname === "/dev-api/watchlist") {
      return await watchlist(url, res, { tokenMode: "env" });
    }

    if (url.pathname === "/api/session") {
      return await sessionInfo(req, res);
    }

    if (url.pathname === "/api/watchlist") {
      return await watchlist(url, res, { req, tokenMode: "session" });
    }

    if (url.pathname === "/auth/login") {
      return await authLogin(req, res);
    }

    if (url.pathname === "/auth/callback") {
      return await authCallback(url, res);
    }

    if (url.pathname === "/auth/logout") {
      return authLogout(req, res);
    }

    return serveStatic(url.pathname, res);
  } catch (error) {
    console.error(error);
    const statusCode = error.message.includes("Invalid token") || error.message.includes("Unauthorized") ? 401 : 500;
    jsonResponse(res, statusCode, { error: error.message });
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

async function sessionInfo(req, res) {
  const session = await getSession(req);
  if (!session) return jsonResponse(res, 200, { authenticated: false });
  const tokenSummary = summarizeToken(session.accessToken);
  jsonResponse(res, 200, {
    authenticated: true,
    character: {
      id: tokenSummary.characterId,
      name: tokenSummary.characterName
    },
    scopes: tokenSummary.scopes,
    expires: tokenSummary.expires
  });
}

async function watchlist(url, res, options) {
  const auth = options.tokenMode === "session" ? await getSession(options.req) : await getEnvAuth();
  if (!auth?.token) {
    const message = options.tokenMode === "session"
      ? "Log in with EVE SSO to load market activity."
      : "Set EVE_ACCESS_TOKEN in .env with a current access token.";
    return jsonResponse(res, 401, { error: message });
  }

  const tokenSummary = summarizeToken(auth.token);
  const claims = decodeJwtPayload(auth.token);
  const characterId = auth.characterId || process.env.EVE_CHARACTER_ID || characterIdFromClaims(claims);
  if (!characterId) return jsonResponse(res, 400, { error: "Could not infer character id from token." });

  const days = Number(url.searchParams.get("days") || 365);
  const hub = HUBS[url.searchParams.get("hub") || "jita"] || HUBS.jita;
  const marketLimit = Number(url.searchParams.get("marketLimit") || 30);
  const typesById = await loadMarketTypes();
  const transactions = await fetchTransactions(characterId, auth.token, Number(url.searchParams.get("maxPages") || 20));
  const watchlistRows = buildWatchlist(transactions, typesById, { days });
  const rows = await attachHubMarket(watchlistRows, hub, marketLimit);

  jsonResponse(res, 200, {
    generatedAt: new Date().toISOString(),
    character: {
      id: characterId,
      name: tokenSummary.characterName || null
    },
    window: {
      requestedDays: days,
      fetchedTransactions: transactions.length,
      itemCount: rows.length,
      note: "ESI returns the wallet transaction history currently available to the character; the app filters that result to the requested day window."
    },
    hub,
    rows
  });
}

async function getEnvAuth() {
  const token = await readLocalToken();
  if (!token) return null;
  return { token };
}

async function authLogin(req, res) {
  const config = getMainSsoConfig(req);
  if (!config.clientId) return jsonResponse(res, 500, { error: "Missing EVE_APP_CLIENT_ID in .env." });

  const state = randomId(24);
  pendingStates.set(state, { createdAt: Date.now() });

  const metadata = await fetch("https://login.eveonline.com/.well-known/oauth-authorization-server").then((response) => response.json());
  const loginUrl = new URL(metadata.authorization_endpoint);
  loginUrl.searchParams.set("response_type", "code");
  loginUrl.searchParams.set("client_id", config.clientId);
  loginUrl.searchParams.set("redirect_uri", config.redirectUri);
  loginUrl.searchParams.set("scope", config.scopes);
  loginUrl.searchParams.set("state", state);

  res.writeHead(302, { location: loginUrl.toString() });
  res.end();
}

async function authCallback(url, res) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");
  if (error) return redirectApp(res, `?auth_error=${encodeURIComponent(error)}`);
  if (!code || !state || !pendingStates.has(state)) {
    return redirectApp(res, "?auth_error=invalid_state");
  }
  pendingStates.delete(state);

  const config = getMainSsoConfig();
  const tokenResponse = await exchangeAuthorizationCode(code, config);
  const accessToken = tokenResponse.access_token;
  const tokenSummary = summarizeToken(accessToken);
  if (!tokenSummary.jwt) return redirectApp(res, "?auth_error=invalid_token");

  const sessionId = randomId(32);
  sessions.set(sessionId, {
    accessToken,
    refreshToken: tokenResponse.refresh_token || null,
    characterId: tokenSummary.characterId,
    createdAt: Date.now()
  });

  res.writeHead(302, {
    location: "/app/",
    "set-cookie": sessionCookie(sessionId)
  });
  res.end();
}

function authLogout(req, res) {
  const sessionId = getCookie(req, "emm_session");
  if (sessionId) sessions.delete(sessionId);
  res.writeHead(302, {
    location: "/app/",
    "set-cookie": "emm_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  });
  res.end();
}

async function getSession(req) {
  const sessionId = getCookie(req, "emm_session");
  if (!sessionId) return null;
  const session = sessions.get(sessionId);
  if (!session) return null;

  const tokenSummary = summarizeToken(session.accessToken);
  const expiresAt = tokenSummary.expires ? new Date(tokenSummary.expires).getTime() : 0;
  if (session.refreshToken && expiresAt && expiresAt - Date.now() < 120000) {
    const refreshed = await refreshAccessToken(session.refreshToken, getMainSsoConfig(req));
    session.accessToken = refreshed.access_token;
    session.refreshToken = refreshed.refresh_token || session.refreshToken;
  }

  return { token: session.accessToken, characterId: session.characterId };
}

async function exchangeAuthorizationCode(code, config) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: config.redirectUri
  });
  return tokenRequest(body, config);
}

async function refreshAccessToken(refreshToken, config) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken
  });
  return tokenRequest(body, config);
}

async function tokenRequest(body, config) {
  const headers = { "content-type": "application/x-www-form-urlencoded" };
  if (config.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64")}`;
  } else {
    body.set("client_id", config.clientId);
  }

  const response = await fetch("https://login.eveonline.com/v2/oauth/token", {
    method: "POST",
    headers,
    body
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${JSON.stringify(payload)}`);
  return payload;
}

function getMainSsoConfig(req = null) {
  const host = req?.headers?.host || `localhost:${port}`;
  return {
    clientId: process.env.EVE_APP_CLIENT_ID || process.env.EVE_CLIENT_ID || "",
    clientSecret: process.env.EVE_APP_CLIENT_SECRET || process.env.EVE_CLIENT_SECRET || "",
    redirectUri: process.env.EVE_APP_REDIRECT_URI || `http://${host}/auth/callback`,
    scopes: process.env.EVE_APP_SCOPES || process.env.EVE_SCOPES || "esi-markets.read_character_orders.v1 esi-wallet.read_character_wallet.v1"
  };
}

function redirectApp(res, query = "") {
  res.writeHead(302, { location: `/app/${query}` });
  res.end();
}

function sessionCookie(sessionId) {
  return `emm_session=${sessionId}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`;
}

function getCookie(req, name) {
  const cookies = Object.fromEntries((req.headers.cookie || "").split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return ["", ""];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }));
  return cookies[name] || null;
}

function randomId(bytes) {
  return randomBytes(bytes).toString("base64url");
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
