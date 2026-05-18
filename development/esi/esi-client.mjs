import { getCompatibilityDate } from "../lib.mjs";

const ESI_BASE_URL = "https://esi.evetech.net/latest";

export async function esi(path, options = {}) {
  const url = new URL(`${ESI_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`);
  url.searchParams.set("datasource", options.datasource || "tranquility");
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }

  const headers = {
    accept: "application/json",
    "user-agent": "eve-market-master-local-dev",
    "x-compatibility-date": options.compatibilityDate || getCompatibilityDate(),
    ...options.headers
  };

  if (options.token) headers.authorization = `Bearer ${options.token}`;

  const response = await fetch(url, { method: options.method || "GET", headers });
  const bodyText = await response.text();
  const body = parseBody(bodyText);

  return {
    ok: response.ok,
    status: response.status,
    statusText: response.statusText,
    headers: Object.fromEntries(response.headers.entries()),
    url: url.toString(),
    body
  };
}

export async function pagedEsi(path, options = {}) {
  const first = await esi(path, options);
  const pages = Number(first.headers["x-pages"] || 1);
  const results = Array.isArray(first.body) ? [...first.body] : [first.body];

  for (let page = 2; page <= pages; page += 1) {
    const response = await esi(path, {
      ...options,
      query: { ...options.query, page }
    });
    if (!response.ok) throw new Error(`ESI page ${page} failed: ${response.status} ${response.statusText}`);
    if (Array.isArray(response.body)) results.push(...response.body);
  }

  return { first, pages, body: results };
}

function parseBody(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
