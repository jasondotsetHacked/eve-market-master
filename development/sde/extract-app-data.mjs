#!/usr/bin/env node
import { createReadStream } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

const extractedDir = resolve("development/sde/data/extracted");
const appDataDir = resolve("app/data");

await mkdir(appDataDir, { recursive: true });

const files = await readdir(extractedDir, { recursive: true });
const invTypesPath = files.find((file) => file === "types.jsonl" || file.endsWith("/types.jsonl"));
const marketGroupsPath = files.find((file) => file === "marketGroups.jsonl" || file.endsWith("/marketGroups.jsonl"));

if (!invTypesPath) {
  throw new Error("Could not find inventory types JSONL. Run npm run sde:fetch first.");
}

const marketTypes = [];
for await (const record of readJsonLines(resolve(extractedDir, invTypesPath))) {
  if (!record.published) continue;
  if (!record.marketGroupID && !record.marketGroupId) continue;
  marketTypes.push({
    typeID: record._key || record.typeID || record.typeId,
    name: localized(record.name),
    marketGroupID: record.marketGroupID || record.marketGroupId,
    volume: record.volume,
    packagedVolume: record.packagedVolume
  });
}

marketTypes.sort((a, b) => a.name.localeCompare(b.name));
await writeFile(resolve(appDataDir, "market-types.json"), `${JSON.stringify(marketTypes, null, 2)}\n`);

if (marketGroupsPath) {
  const marketGroups = [];
  for await (const record of readJsonLines(resolve(extractedDir, marketGroupsPath))) {
    marketGroups.push({
      marketGroupID: record._key || record.marketGroupID || record.marketGroupId,
      parentGroupID: record.parentGroupID || record.parentGroupId || null,
      name: localized(record.name),
      description: localized(record.description)
    });
  }
  marketGroups.sort((a, b) => a.name.localeCompare(b.name));
  await writeFile(resolve(appDataDir, "market-groups.json"), `${JSON.stringify(marketGroups, null, 2)}\n`);
}

console.log(`Wrote ${marketTypes.length} market type records to ${appDataDir}`);

async function* readJsonLines(path) {
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity
  });
  for await (const line of reader) {
    if (line.trim()) yield JSON.parse(line);
  }
}

function localized(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.en || value["en-us"] || Object.values(value)[0] || "";
}
