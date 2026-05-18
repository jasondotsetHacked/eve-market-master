import { readFile } from "node:fs/promises";

export async function readLocalToken(path = null) {
  const candidates = [];

  addCandidate(process.env.EVE_ACCESS_TOKEN);
  if (path) {
    try {
      const raw = (await readFile(path, "utf8")).trim();
      if (raw) {
        addCandidate(raw);
        addJwtCandidates(raw);
        addJsonCandidates(raw);
        addKeyValueCandidates(raw);
        for (const part of raw.split(/\s+/)) addCandidate(part);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  return candidates.find(Boolean) || null;

  function addCandidate(value) {
    if (typeof value !== "string") return;
    const cleaned = value.trim().replace(/^Bearer\s+/i, "");
    if (cleaned.length > 40 && !candidates.includes(cleaned)) candidates.push(cleaned);
  }

  function addJsonCandidates(raw) {
    try {
      const parsed = JSON.parse(raw);
      addCandidate(parsed.access_token);
      addCandidate(parsed.token);
      addCandidate(parsed.refresh_token);
    } catch {
      // Not JSON.
    }
  }

  function addJwtCandidates(raw) {
    const matches = raw.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) || [];
    for (const match of matches) addCandidate(match);
  }

  function addKeyValueCandidates(raw) {
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/i);
      if (!match) continue;
      if (/TOKEN|ACCESS/i.test(match[1])) addCandidate(match[2].replace(/^["']|["']$/g, ""));
    }
  }
}

export function decodeJwtPayload(token) {
  if (!token || token.split(".").length !== 3) return null;
  try {
    const payload = token.split(".")[1];
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

export function characterIdFromClaims(claims) {
  const subject = claims?.sub || "";
  const match = subject.match(/CHARACTER:EVE:(\d+)/i);
  return match?.[1] || null;
}

export function summarizeToken(token) {
  const claims = decodeJwtPayload(token);
  if (!claims) return { present: Boolean(token), jwt: false };
  return {
    present: true,
    jwt: true,
    characterId: characterIdFromClaims(claims),
    characterName: claims.name || null,
    scopes: claims.scp || claims.scope || [],
    expires: claims.exp ? new Date(claims.exp * 1000).toISOString() : null
  };
}
