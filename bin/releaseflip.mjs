#!/usr/bin/env node
import { randomBytes, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createClient, DeployError } from "../lib/client.mjs";
import { collectFiles } from "../lib/files.mjs";
import { createZip } from "../lib/zip.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(await readFile(join(here, "../package.json"), "utf8"));

const HELP = `releaseflip ${pkg.version}
Atomic deploys and instant rollback for shared hosting. No SSH needed.

Usage
  releaseflip setup [folder]       Write releaseflip.php and its config, ready to upload
  releaseflip deploy [source]      Upload a folder and flip it live
  releaseflip rollback [release]   Flip back to the previous (or a named) release
  releaseflip list                 Show releases on the server
  releaseflip check                Test the connection and the server setup
  releaseflip token                Print a new token and its hash

Options
  --url <url>          Address of releaseflip.php (or "url" in releaseflip.json)
  --exclude <pattern>  Leave matching files out of the package (repeatable)
  --dry-run            Show what deploy would upload, without uploading
  -h, --help           Show this help
  -v, --version        Show the version

The token is read from the RELEASEFLIP_TOKEN environment variable, never from a file.`;

const out = (line = "") => process.stdout.write(`${line}\n`);
const fail = (message) => {
  process.stderr.write(`\n  ✗ ${message}\n\n`);
  process.exit(1);
};
const megabytes = (bytes) =>
  bytes < 1048576 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(bytes < 10485760 ? 2 : 1)} MB`;
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string" },
    exclude: { type: "string", multiple: true, default: [] },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
    version: { type: "boolean", short: "v", default: false }
  }
});

const [command = "help", argument] = positionals;

if (values.version) {
  out(pkg.version);
  process.exit(0);
}
if (values.help || command === "help") {
  out(HELP);
  process.exit(0);
}

const readProjectConfig = async () => {
  const path = resolve("releaseflip.json");
  if (!existsSync(path)) return {};
  let config;
  try {
    config = JSON.parse(await readFile(path, "utf8"));
  } catch {
    fail("releaseflip.json is not valid JSON.");
  }
  if ("token" in config) fail('Remove "token" from releaseflip.json. Put it in the RELEASEFLIP_TOKEN environment variable instead.');
  return config;
};

const newToken = () => {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: createHash("sha256").update(token).digest("hex") };
};

const connect = async () => {
  const config = await readProjectConfig();
  const url = values.url || config.url || process.env.RELEASEFLIP_URL;
  if (!url) fail('Missing the server address. Pass --url or add "url" to releaseflip.json.');
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    fail(`"${url}" is not a valid URL.`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !local) fail("Use an https:// address so the token is never sent in clear text.");
  const token = process.env.RELEASEFLIP_TOKEN;
  if (!token) fail("Set the RELEASEFLIP_TOKEN environment variable to the token from setup.");
  return { client: createClient({ url, token }), config, url };
};

const run = async () => {
  if (command === "token") {
    const { token, hash } = newToken();
    out(`\n  Token (keep secret, store as RELEASEFLIP_TOKEN):\n  ${token}\n\n  Hash (paste into releaseflip.config.php as token_sha256):\n  ${hash}\n`);
    return;
  }

  if (command === "setup") {
    const folder = resolve(argument || "releaseflip-server");
    if (existsSync(join(folder, "releaseflip.config.php"))) fail(`${folder} already has a releaseflip.config.php. Choose another folder.`);
    await mkdir(folder, { recursive: true });
    const { token, hash } = newToken();
    const receiver = await readFile(join(here, "../server/releaseflip.php"), "utf8");
    const example = await readFile(join(here, "../server/releaseflip.config.example.php"), "utf8");
    await writeFile(join(folder, "releaseflip.php"), receiver);
    await writeFile(join(folder, "releaseflip.config.php"), example.replace("PASTE-THE-HASH-FROM-releaseflip-token", hash), { mode: 0o600 });
    out(`
  Wrote ${join(folder, "releaseflip.php")}
  Wrote ${join(folder, "releaseflip.config.php")}

  Your token (shown once, keep it secret):
  ${token}

  Next
  1. Edit releaseflip.config.php: set "docroot" and the "protect" list.
  2. Upload releaseflip.config.php one folder ABOVE your web root.
  3. Upload releaseflip.php INTO your web root.
  4. Save the token as RELEASEFLIP_TOKEN (locally, or as a GitHub secret).
  5. Run: releaseflip check --url https://your-site.com/releaseflip.php
`);
    return;
  }

  if (command === "deploy") {
    const config = await readProjectConfig();
    const source = resolve(argument || config.source || ".");
    if (!existsSync(source) || !(await stat(source)).isDirectory()) fail(`${source} is not a folder.`);
    const { files, skipped } = await collectFiles(source, [...(config.exclude || []), ...values.exclude]);
    if (!files.length) fail(`${source} has no files to deploy.`);
    const zip = createZip(files);
    out(`\n  Packed ${plural(files.length, "file")} from ${source} (${megabytes(zip.length)})`);
    if (skipped.length) out(`  Skipped ${skipped.length} symlink${skipped.length === 1 ? "" : "s"}: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}`);
    if (values["dry-run"]) {
      for (const file of files) out(`    ${file.name}`);
      out("\n  Dry run: nothing was uploaded.\n");
      return;
    }
    const { client, url } = await connect();
    let last = -1;
    const result = await client.deploy(zip, (sent, total) => {
      const percent = Math.floor((sent / total) * 100);
      if (process.stdout.isTTY) {
        process.stdout.write(`\r  Uploading to ${new URL(url).host} … ${percent}%`);
      } else if (percent >= last + 25 || sent === total) {
        out(`  Uploading … ${percent}%`);
        last = percent;
      }
    });
    if (process.stdout.isTTY) process.stdout.write("\n");
    out(`  ✓ Live: ${result.live}`);
    out(`  Previous: ${result.previous} (roll back with: releaseflip rollback)`);
    if (result.pruned?.length) out(`  Removed old releases: ${result.pruned.join(", ")}`);
    out();
    return;
  }

  if (command === "rollback") {
    const { client } = await connect();
    const result = await client.rollback(argument);
    out(`\n  ✓ Live: ${result.live}\n  Previous: ${result.previous}\n`);
    return;
  }

  if (command === "list") {
    const { client } = await connect();
    const { releases } = await client.list();
    out();
    if (!releases.length) out("  No releases yet.");
    for (const release of releases) out(`  ${release.live ? "●" : "○"} ${release.id}${release.live ? "  (live)" : ""}`);
    out();
    return;
  }

  if (command === "check") {
    const { client, url } = await connect();
    const info = await client.ping();
    out(`\n  ✓ Connected to ${url}`);
    out(`  Server: releaseflip ${info.version}, PHP ${info.php}`);
    out(`  ${info.zip ? "✓" : "✗"} PHP zip support${info.zip ? "" : " is missing. Ask your host to enable it."}`);
    out(`  ${info.docroot_writable ? "✓" : "✗"} The folder above the web root is ${info.docroot_writable ? "writable" : "NOT writable, so flips will fail"}`);
    out(`  Live release: ${info.live ?? "none yet (the current site becomes the first rollback point)"}\n`);
    return;
  }

  fail(`Unknown command "${command}". Run releaseflip --help.`);
};

try {
  await run();
} catch (error) {
  if (error instanceof DeployError) fail(error.message);
  throw error;
}
