import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { esi, pagedEsi } from "./esi-client.mjs";

export const HUBS = {
  jita: { key: "jita", name: "Jita", regionId: 10000002, stationId: 60003760 },
  amarr: { key: "amarr", name: "Amarr", regionId: 10000043, stationId: 60008494 },
  dodixie: { key: "dodixie", name: "Dodixie", regionId: 10000032, stationId: 60011866 },
  rens: { key: "rens", name: "Rens", regionId: 10000030, stationId: 60004588 },
  hek: { key: "hek", name: "Hek", regionId: 10000042, stationId: 60005686 }
};

export async function loadMarketTypes() {
  const path = resolve("app/data/market-types.json");
  const types = JSON.parse(await readFile(path, "utf8"));
  return new Map(types.map((type) => [Number(type.typeID), type]));
}

export async function fetchTransactions(characterId, token, maxPages = 20) {
  const all = [];
  let fromId = null;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await esi(`/characters/${characterId}/wallet/transactions/`, {
      token,
      query: fromId ? { from_id: fromId } : {}
    });
    if (!response.ok) {
      throw new Error(`Wallet transactions failed: ${response.status} ${JSON.stringify(response.body)}`);
    }

    const batch = Array.isArray(response.body) ? response.body : [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 2500) break;

    fromId = Math.min(...batch.map((transaction) => transaction.transaction_id)) - 1;
  }

  return dedupeBy(all, "transaction_id");
}

export async function fetchJournal(characterId, token, maxPages = 20) {
  const all = [];
  let fromId = null;

  for (let page = 0; page < maxPages; page += 1) {
    const response = await esi(`/characters/${characterId}/wallet/journal/`, {
      token,
      query: fromId ? { from_id: fromId } : {}
    });
    if (!response.ok) {
      throw new Error(`Wallet journal failed: ${response.status} ${JSON.stringify(response.body)}`);
    }

    const batch = Array.isArray(response.body) ? response.body : [];
    if (batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 2500) break;

    fromId = Math.min(...batch.map((entry) => entry.id)) - 1;
  }

  return dedupeBy(all, "id");
}

export function buildWatchlist(transactions, typesById, options = {}) {
  const now = options.now || new Date();
  const days = Number(options.days || 365);
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const recent = transactions.filter((transaction) => new Date(transaction.date) >= cutoff);
  const groups = new Map();

  for (const transaction of recent) {
    const typeId = Number(transaction.type_id);
    if (!groups.has(typeId)) groups.set(typeId, []);
    groups.get(typeId).push(transaction);
  }

  return [...groups.entries()]
    .map(([typeId, rows]) => summarizeType(typeId, rows, typesById))
    .sort((a, b) => {
      const aDate = new Date(a.lastTransactionDate || 0).getTime();
      const bDate = new Date(b.lastTransactionDate || 0).getTime();
      return bDate - aDate || b.totalGrossValue - a.totalGrossValue;
    });
}

export async function attachHubMarket(rows, hub = HUBS.jita, limit = 40) {
  const selected = rows.slice(0, limit);
  const results = await runLimited(selected, 4, async (row) => ({
    typeId: row.typeID,
    market: await fetchHubMarket(row.typeID, hub)
  }));
  const byType = new Map(results.map((result) => [result.typeId, result.market]));
  return rows.map((row) => ({ ...row, market: byType.get(row.typeID) || null }));
}

export async function fetchHubMarket(typeId, hub = HUBS.jita) {
  const response = await pagedEsi(`/markets/${hub.regionId}/orders/`, {
    query: { order_type: "all", type_id: typeId }
  });
  const orders = response.body.filter((order) => Number(order.location_id) === hub.stationId);
  const sells = orders.filter((order) => !order.is_buy_order);
  const buys = orders.filter((order) => order.is_buy_order);
  const bestSell = minBy(sells, "price");
  const bestBuy = maxBy(buys, "price");

  return {
    hub,
    orderCount: orders.length,
    sellCount: sells.length,
    buyCount: buys.length,
    bestSell: orderPrice(bestSell),
    bestBuy: orderPrice(bestBuy),
    spread: bestSell && bestBuy ? roundMoney(bestSell.price - bestBuy.price) : null
  };
}

export function summarizeTransactions(transactions) {
  const quantity = transactions.reduce((sum, transaction) => sum + Number(transaction.quantity || 0), 0);
  const grossValue = transactions.reduce((sum, transaction) => {
    return sum + Number(transaction.quantity || 0) * Number(transaction.unit_price || 0);
  }, 0);

  return {
    count: transactions.length,
    quantity,
    grossValue: roundMoney(grossValue),
    weightedAverageUnitPrice: quantity > 0 ? roundMoney(grossValue / quantity) : null
  };
}

export function summarizeJournalMatches(transactions, journal) {
  const transactionIds = new Set(transactions.map((transaction) => Number(transaction.transaction_id)));
  const matched = journal.filter((entry) => transactionIds.has(Number(entry.context_id)));
  const byContext = new Map();
  for (const entry of matched) {
    const contextId = Number(entry.context_id);
    if (!byContext.has(contextId)) byContext.set(contextId, []);
    byContext.get(contextId).push(entry);
  }

  return {
    matchedCount: matched.length,
    totalAmount: roundMoney(matched.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)),
    refTypes: [...new Set(matched.map((entry) => entry.ref_type))].sort(),
    byTransactionId: Object.fromEntries(byContext.entries())
  };
}

function summarizeType(typeId, rows, typesById) {
  const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
  const buys = sorted.filter((transaction) => transaction.is_buy);
  const sells = sorted.filter((transaction) => !transaction.is_buy);
  const buySummary = summarizeTransactions(buys);
  const sellSummary = summarizeTransactions(sells);
  const type = typesById.get(typeId) || { typeID: typeId, name: `Type ${typeId}` };
  const estimatedQuantity = buySummary.quantity - sellSummary.quantity;
  const grossSpread = buySummary.weightedAverageUnitPrice !== null && sellSummary.weightedAverageUnitPrice !== null
    ? roundMoney(sellSummary.weightedAverageUnitPrice - buySummary.weightedAverageUnitPrice)
    : null;

  return {
    typeID: typeId,
    name: type.name,
    marketGroupID: type.marketGroupID,
    firstTransactionDate: sorted[0]?.date || null,
    lastTransactionDate: sorted.at(-1)?.date || null,
    transactionCount: sorted.length,
    totalGrossValue: roundMoney(buySummary.grossValue + sellSummary.grossValue),
    buys: buySummary,
    sells: sellSummary,
    position: {
      estimatedQuantity,
      weightedAverageBuy: buySummary.weightedAverageUnitPrice,
      weightedAverageSell: sellSummary.weightedAverageUnitPrice,
      grossAverageSpread: grossSpread,
      estimatedOpenBuyCost: roundMoney(Math.max(estimatedQuantity, 0) * (buySummary.weightedAverageUnitPrice || 0))
    }
  };
}

function dedupeBy(rows, key) {
  return [...new Map(rows.map((row) => [row[key], row])).values()];
}

function minBy(values, key) {
  return values.reduce((best, value) => (best === null || value[key] < best[key] ? value : best), null);
}

function maxBy(values, key) {
  return values.reduce((best, value) => (best === null || value[key] > best[key] ? value : best), null);
}

function orderPrice(order) {
  if (!order) return null;
  return {
    price: order.price,
    volumeRemain: order.volume_remain,
    issued: order.issued,
    locationId: order.location_id
  };
}

async function runLimited(values, concurrency, task) {
  const results = [];
  let index = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (index < values.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await task(values[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
