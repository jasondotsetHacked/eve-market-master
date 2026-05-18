#!/usr/bin/env node
import { loadEnv } from "../lib.mjs";
import { esi, pagedEsi } from "./esi-client.mjs";

await loadEnv();

const [, , command = "status", ...args] = process.argv;
const flags = parseFlags(args);

const commands = {
  async status() {
    return esi("/status/");
  },
  async "market-orders"() {
    const region = flags.region || process.env.EVE_REGION_ID || "10000002";
    const type = flags.type;
    const response = await pagedEsi(`/markets/${region}/orders/`, {
      query: { order_type: flags.orderType || "all", type_id: type }
    });
    return {
      url: response.first.url,
      pages: response.pages,
      count: response.body.length,
      sample: response.body.slice(0, Number(flags.limit || 10))
    };
  },
  async "character-orders"() {
    const characterId = required(flags.character || process.env.EVE_CHARACTER_ID, "character id");
    const token = required(flags.token || process.env.EVE_ACCESS_TOKEN, "access token");
    return pagedEsi(`/characters/${characterId}/orders/`, { token });
  },
  async route() {
    const path = required(flags.path, "--path");
    return esi(path, { token: flags.token || process.env.EVE_ACCESS_TOKEN });
  }
};

if (!commands[command]) {
  console.error(`Unknown command "${command}". Try: ${Object.keys(commands).join(", ")}`);
  process.exit(1);
}

const result = await commands[command]();
console.log(JSON.stringify(result, null, 2));

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

function required(value, label) {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}
