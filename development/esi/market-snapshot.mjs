#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnv } from "../lib.mjs";
import { esi, pagedEsi } from "./esi-client.mjs";
import { characterIdFromClaims, decodeJwtPayload, readLocalToken, summarizeToken } from "./token-store.mjs";

await loadEnv();

const snapshotTime = new Date();
const outDir = resolve("development/cache/esi-snapshots", snapshotTime.toISOString().replace(/[:.]/g, "-"));
await mkdir(outDir, { recursive: true });

const hubs = [
  { key: "jita", name: "Jita IV - Moon 4 - Caldari Navy Assembly Plant", regionId: 10000002, stationId: 60003760 },
  { key: "amarr", name: "Amarr VIII (Oris) - Emperor Family Academy", regionId: 10000043, stationId: 60008494 },
  { key: "dodixie", name: "Dodixie IX - Moon 20 - Federation Navy Assembly Plant", regionId: 10000032, stationId: 60011866 },
  { key: "rens", name: "Rens VI - Moon 8 - Brutor Tribe Treasury", regionId: 10000030, stationId: 60004588 },
  { key: "hek", name: "Hek VIII - Moon 12 - Boundless Creation Factory", regionId: 10000042, stationId: 60005686 }
];

const types = [
  { typeId: 34, name: "Tritanium" },
  { typeId: 35, name: "Pyerite" },
  { typeId: 36, name: "Mexallon" },
  { typeId: 37, name: "Isogen" },
  { typeId: 38, name: "Nocxium" },
  { typeId: 39, name: "Zydrine" },
  { typeId: 40, name: "Megacyte" },
  { typeId: 40520, name: "Large Skill Injector" }
];

const token = await readLocalToken();
const tokenSummary = summarizeToken(token);
const snapshot = {
  generatedAt: snapshotTime.toISOString(),
  note: "Public market data requires no EVE SSO token. Authenticated sections are included only when a valid access token is available.",
  hubs,
  types,
  tokenSummary,
  publicMarket: [],
  authenticated: {}
};

for (const hub of hubs) {
  for (const type of types) {
    const market = await loadMarket(hub, type);
    snapshot.publicMarket.push(market);
    await writeJson(`${hub.key}-${type.typeId}-orders-summary.json`, market);
  }
}

await loadAuthenticatedSamples();
await writeJson("snapshot.json", snapshot);
console.log(`Wrote ESI snapshot: ${outDir}`);
console.log(`Public market samples: ${snapshot.publicMarket.length}`);
console.log(`Authenticated token usable: ${Boolean(token && tokenSummary.jwt)}`);

async function loadMarket(hub, type) {
  const ordersResult = await pagedEsi(`/markets/${hub.regionId}/orders/`, {
    query: { order_type: "all", type_id: type.typeId }
  });
  const orders = ordersResult.body.filter((order) => order && typeof order === "object");
  const stationOrders = orders.filter((order) => Number(order.location_id) === hub.stationId);
  const sellOrders = orders.filter((order) => !order.is_buy_order);
  const buyOrders = orders.filter((order) => order.is_buy_order);
  const hubSells = stationOrders.filter((order) => !order.is_buy_order);
  const hubBuys = stationOrders.filter((order) => order.is_buy_order);
  const history = await esi(`/markets/${hub.regionId}/history/`, {
    query: { type_id: type.typeId }
  });

  return {
    hub: pick(hub, ["key", "name", "regionId", "stationId"]),
    type,
    ordersUrl: ordersResult.first.url,
    pages: ordersResult.pages,
    regionOrderCount: orders.length,
    hubOrderCount: stationOrders.length,
    region: summarizeSide(sellOrders, buyOrders),
    hubStation: summarizeSide(hubSells, hubBuys),
    shape: sampleShape(orders[0]),
    topHubSells: topSells(hubSells, 5),
    topHubBuys: topBuys(hubBuys, 5),
    recentHistory: Array.isArray(history.body) ? history.body.slice(-14) : history.body
  };
}

async function loadAuthenticatedSamples() {
  if (!token || !tokenSummary.jwt) {
    snapshot.authenticated.skipped = "No JWT access token found in EVE_ACCESS_TOKEN.";
    return;
  }

  const claims = decodeJwtPayload(token);
  const characterId = process.env.EVE_CHARACTER_ID || characterIdFromClaims(claims);
  if (!characterId) {
    snapshot.authenticated.skipped = "Could not infer character id from token.";
    return;
  }

  const scopes = new Set(Array.isArray(tokenSummary.scopes) ? tokenSummary.scopes : String(tokenSummary.scopes || "").split(/\s+/));
  snapshot.authenticated.characterId = characterId;

  if (scopes.has("esi-markets.read_character_orders.v1")) {
    const orders = await pagedEsi(`/characters/${characterId}/orders/`, { token });
    snapshot.authenticated.characterOrders = {
      status: orders.first.status,
      pages: orders.pages,
      count: orders.body.length,
      shape: sampleShape(orders.body[0]),
      sample: sanitizeOrders(orders.body.slice(0, 10))
    };
  } else {
    snapshot.authenticated.characterOrders = { skipped: "Missing esi-markets.read_character_orders.v1" };
  }

  if (scopes.has("esi-wallet.read_character_wallet.v1")) {
    const wallet = await esi(`/characters/${characterId}/wallet/`, { token });
    snapshot.authenticated.walletBalance = {
      status: wallet.status,
      shape: typeof wallet.body,
      body: wallet.ok ? wallet.body : wallet.body
    };
  } else {
    snapshot.authenticated.walletBalance = { skipped: "Missing esi-wallet.read_character_wallet.v1" };
  }

  if (scopes.has("esi-wallet.read_character_wallet.v1")) {
    const transactions = await esi(`/characters/${characterId}/wallet/transactions/`, { token });
    snapshot.authenticated.walletTransactions = {
      status: transactions.status,
      count: Array.isArray(transactions.body) ? transactions.body.length : null,
      shape: sampleShape(Array.isArray(transactions.body) ? transactions.body[0] : transactions.body),
      sample: Array.isArray(transactions.body) ? transactions.body.slice(0, 10) : transactions.body
    };
  }
}

function summarizeSide(sells, buys) {
  const bestSell = minBy(sells, "price");
  const bestBuy = maxBy(buys, "price");
  return {
    sellCount: sells.length,
    buyCount: buys.length,
    bestSell: priceSummary(bestSell),
    bestBuy: priceSummary(bestBuy),
    spread: bestSell && bestBuy ? Number((bestSell.price - bestBuy.price).toFixed(2)) : null
  };
}

function topSells(orders, count) {
  return [...orders].sort((a, b) => a.price - b.price).slice(0, count).map(priceSummary);
}

function topBuys(orders, count) {
  return [...orders].sort((a, b) => b.price - a.price).slice(0, count).map(priceSummary);
}

function priceSummary(order) {
  if (!order) return null;
  return {
    price: order.price,
    volumeRemain: order.volume_remain,
    volumeTotal: order.volume_total,
    locationId: order.location_id,
    systemId: order.system_id,
    issued: order.issued,
    duration: order.duration,
    minVolume: order.min_volume
  };
}

function sampleShape(value) {
  if (!value || typeof value !== "object") return value ?? null;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, Array.isArray(entry) ? "array" : typeof entry]));
}

function sanitizeOrders(orders) {
  return orders.map((order) => ({
    duration: order.duration,
    is_buy_order: order.is_buy_order,
    issued: order.issued,
    location_id: order.location_id,
    price: order.price,
    range: order.range,
    region_id: order.region_id,
    type_id: order.type_id,
    volume_remain: order.volume_remain,
    volume_total: order.volume_total
  }));
}

function minBy(values, key) {
  return values.reduce((best, value) => (best === null || value[key] < best[key] ? value : best), null);
}

function maxBy(values, key) {
  return values.reduce((best, value) => (best === null || value[key] > best[key] ? value : best), null);
}

function pick(object, keys) {
  return Object.fromEntries(keys.map((key) => [key, object[key]]));
}

async function writeJson(name, value) {
  await writeFile(resolve(outDir, name), `${JSON.stringify(value, null, 2)}\n`);
}
