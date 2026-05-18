#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadEnv } from "../lib.mjs";
import {
  fetchJournal,
  fetchTransactions,
  loadMarketTypes,
  summarizeJournalMatches,
  summarizeTransactions
} from "./market-analysis.mjs";
import { characterIdFromClaims, decodeJwtPayload, readLocalToken, summarizeToken } from "./token-store.mjs";

await loadEnv();

const flags = parseFlags(process.argv.slice(2));
const token = await readLocalToken();
const tokenSummary = summarizeToken(token);
if (!token || !tokenSummary.jwt) throw new Error("Set EVE_ACCESS_TOKEN in .env with a current JWT access token.");

const characterId = flags.character || process.env.EVE_CHARACTER_ID || characterIdFromClaims(decodeJwtPayload(token));
if (!characterId) throw new Error("Could not infer character id from token.");

const type = await resolveType(flags.typeId, flags.item || flags.name || "Water-Cooled CPU");
const transactions = await fetchTransactions(characterId, token, Number(flags.maxPages || 10));
const itemTransactions = transactions.filter((transaction) => Number(transaction.type_id) === type.typeID);
const journal = flags.withJournal ? await fetchJournal(characterId, token, Number(flags.maxPages || 10)) : [];
const result = calculateWeightedAverage(type, itemTransactions, journal);

const outDir = resolve("development/cache/cost-basis");
await mkdir(outDir, { recursive: true });
const outPath = resolve(outDir, `${slug(type.name)}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(outPath, `${JSON.stringify(result, null, 2)}\n`);

console.log(JSON.stringify({
  item: result.item,
  fetchedTransactions: transactions.length,
  matchedTransactions: itemTransactions.length,
  buyQuantity: result.buys.quantity,
  weightedAverageBuy: result.buys.weightedAverageUnitPrice,
  sellQuantity: result.sells.quantity,
  weightedAverageSell: result.sells.weightedAverageUnitPrice,
  journalMatches: result.journal.matchedCount,
  journalMatchedAmount: result.journal.totalAmount,
  estimatedRemainingQuantity: result.position.estimatedRemainingQuantity,
  output: outPath
}, null, 2));

function calculateWeightedAverage(type, transactions, journal) {
  const sorted = [...transactions].sort((a, b) => new Date(a.date) - new Date(b.date));
  const buys = sorted.filter((transaction) => transaction.is_buy);
  const sells = sorted.filter((transaction) => !transaction.is_buy);

  const buySummary = summarizeTransactions(buys);
  const sellSummary = summarizeTransactions(sells);
  const estimatedRemainingQuantity = buySummary.quantity - sellSummary.quantity;

  return {
    generatedAt: new Date().toISOString(),
    item: type,
    notes: [
      "Weighted averages are based on wallet transaction unit_price * quantity.",
      "Journal matching currently records entries whose context_id equals a market transaction_id. Fee allocation will be enabled after we verify the journal shapes for this character."
    ],
    transactionWindow: {
      count: sorted.length,
      firstDate: sorted[0]?.date || null,
      lastDate: sorted.at(-1)?.date || null
    },
    buys: buySummary,
    sells: sellSummary,
    journal: summarizeJournalMatches(sorted, journal),
    position: {
      estimatedRemainingQuantity,
      weightedAverageCostBasis: buySummary.weightedAverageUnitPrice,
      estimatedOpenCost: roundMoney(Math.max(estimatedRemainingQuantity, 0) * (buySummary.weightedAverageUnitPrice || 0))
    },
    transactions: sorted
  };
}

async function resolveType(typeId, name) {
  const typesById = await loadMarketTypes();
  const types = [...typesById.values()];
  if (typeId) {
    const match = types.find((type) => Number(type.typeID) === Number(typeId));
    if (!match) throw new Error(`Unknown type id: ${typeId}`);
    return match;
  }

  const exact = types.find((type) => type.name.toLowerCase() === name.toLowerCase());
  if (exact) return exact;

  const partial = types.filter((type) => type.name.toLowerCase().includes(name.toLowerCase())).slice(0, 10);
  throw new Error(`Unknown item "${name}". Close matches: ${partial.map((type) => `${type.name} (${type.typeID})`).join(", ")}`);
}

function parseFlags(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    const next = values[index + 1];
    parsed[key] = next && !next.startsWith("--") ? values[++index] : true;
  }
  return parsed;
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
