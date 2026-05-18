const metadataUrl = "https://login.eveonline.com/.well-known/oauth-authorization-server";
const storageKey = "eve-market-master-sso";

const clientIdInput = document.querySelector("#client-id");
const redirectUriInput = document.querySelector("#redirect-uri");
const scopesInput = document.querySelector("#scopes");
const tokenOutput = document.querySelector("#token-output");
const claimsList = document.querySelector("#claims");

const config = await fetch("/dev-api/config").then((response) => response.json());
clientIdInput.value = localStorage.getItem("eve-client-id") || config.clientId;
redirectUriInput.value = config.redirectUri;
scopesInput.value = config.scopes;

document.querySelector("#login").addEventListener("click", startLogin);
document.querySelector("#clear").addEventListener("click", () => {
  localStorage.removeItem(storageKey);
  localStorage.removeItem("eve-client-id");
  tokenOutput.textContent = "No token yet.";
  claimsList.replaceChildren();
});

await handleCallback();
renderStoredToken();

async function startLogin() {
  const clientId = clientIdInput.value.trim();
  if (!clientId) throw new Error("Client ID is required");
  localStorage.setItem("eve-client-id", clientId);

  const metadata = await fetch(metadataUrl).then((response) => response.json());
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = await sha256Base64Url(verifier);
  const state = base64Url(crypto.getRandomValues(new Uint8Array(16)));

  sessionStorage.setItem("eve-sso-verifier", verifier);
  sessionStorage.setItem("eve-sso-state", state);

  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUriInput.value.trim());
  url.searchParams.set("scope", scopesInput.value.trim());
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");

  window.location.assign(url);
}

async function handleCallback() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return;

  const expectedState = sessionStorage.getItem("eve-sso-state");
  const verifier = sessionStorage.getItem("eve-sso-verifier");
  if (!expectedState || state !== expectedState) throw new Error("SSO state mismatch");
  if (!verifier) throw new Error("Missing PKCE verifier");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientIdInput.value.trim(),
    code_verifier: verifier
  });

  const response = await fetch("/dev-api/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });

  const token = await response.json();
  if (!response.ok) throw new Error(JSON.stringify(token));
  localStorage.setItem(storageKey, JSON.stringify(token));
  sessionStorage.removeItem("eve-sso-verifier");
  sessionStorage.removeItem("eve-sso-state");
  history.replaceState({}, "", url.pathname);
}

function renderStoredToken() {
  const raw = localStorage.getItem(storageKey);
  if (!raw) return;
  const token = JSON.parse(raw);
  tokenOutput.textContent = JSON.stringify(token, null, 2);
  renderClaims(decodeJwtPayload(token.access_token));
}

function renderClaims(claims) {
  claimsList.replaceChildren();
  const entries = {
    CharacterID: claims.sub?.replace("CHARACTER:EVE:", "") || "",
    CharacterName: claims.name || "",
    Expires: claims.exp ? new Date(claims.exp * 1000).toISOString() : "",
    Scopes: Array.isArray(claims.scp) ? claims.scp.join(" ") : claims.scp || ""
  };
  for (const [key, value] of Object.entries(entries)) {
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = key;
    dd.textContent = value;
    claimsList.append(dt, dd);
  }
}

function decodeJwtPayload(token) {
  if (!token) return {};
  const [, payload] = token.split(".");
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(payload)));
}

async function sha256Base64Url(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base64Url(new Uint8Array(digest));
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function base64UrlToBytes(value) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
