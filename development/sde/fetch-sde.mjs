#!/usr/bin/env node
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { spawn } from "node:child_process";

const latestMetaUrl = "https://developers.eveonline.com/static-data/tranquility/latest.jsonl";
const latestZipUrl = "https://developers.eveonline.com/static-data/eve-online-static-data-latest-jsonl.zip";
const rawDir = resolve("development/sde/data/raw");
const extractedDir = resolve("development/sde/data/extracted");

await mkdir(rawDir, { recursive: true });
await mkdir(extractedDir, { recursive: true });

const metadata = await getLatestMetadata();
const buildNumber = metadata.buildNumber;
const zipPath = resolve(rawDir, `eve-online-static-data-${buildNumber}-jsonl.zip`);

console.log(`Latest SDE build: ${buildNumber} (${metadata.releaseDate})`);
await download(latestZipUrl, zipPath);
console.log(`Downloaded: ${zipPath}`);

if (!process.argv.includes("--no-extract")) {
  await rm(extractedDir, { recursive: true, force: true });
  await mkdir(extractedDir, { recursive: true });
  await unzip(zipPath, extractedDir);
  console.log(`Extracted: ${extractedDir}`);
}

async function getLatestMetadata() {
  const response = await fetch(latestMetaUrl);
  if (!response.ok) throw new Error(`Failed to fetch SDE metadata: ${response.status}`);
  const lines = (await response.text()).trim().split(/\r?\n/);
  for (const line of lines) {
    const record = JSON.parse(line);
    if (record._key === "sde") return record;
  }
  throw new Error("SDE metadata did not contain an sde record");
}

async function download(url, path) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.body) throw new Error(`Failed to download SDE: ${response.status}`);
  await mkdir(dirname(path), { recursive: true });
  await pipeline(response.body, createWriteStream(path));
}

async function unzip(zipPath, destination) {
  const tool = await firstAvailable(["unzip", "bsdtar", "powershell.exe", "python3"]);
  if (!tool) {
    throw new Error("No zip extraction tool found. Install unzip, bsdtar, PowerShell, or python3.");
  }

  const argsByTool = {
    unzip: ["-q", zipPath, "-d", destination],
    bsdtar: ["-xf", zipPath, "-C", destination],
    "powershell.exe": [
      "-NoProfile",
      "-Command",
      `Expand-Archive -LiteralPath '${await windowsPath(zipPath)}' -DestinationPath '${await windowsPath(destination)}' -Force`
    ],
    python3: [
      "-c",
      "import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])",
      zipPath,
      destination
    ]
  };

  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(tool, argsByTool[tool], { stdio: "inherit" });
    child.on("error", rejectPromise);
    child.on("exit", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${tool} exited with ${code}`));
    });
  });
}

async function firstAvailable(commands) {
  for (const command of commands) {
    const available = await new Promise((resolvePromise) => {
      const child = spawn("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" });
      child.on("exit", (code) => resolvePromise(code === 0));
      child.on("error", () => resolvePromise(false));
    });
    if (available) return command;
  }
  return null;
}

async function windowsPath(path) {
  return new Promise((resolvePromise) => {
    const child = spawn("bash", ["-lc", `command -v wslpath >/dev/null && wslpath -w "${path}" || printf %s "${path}"`]);
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.on("exit", () => resolvePromise(Buffer.concat(chunks).toString("utf8").trim().replaceAll("'", "''")));
    child.on("error", () => resolvePromise(path.replaceAll("'", "''")));
  });
}
