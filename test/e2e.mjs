import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "../lib/client.mjs";
import { createZip } from "../lib/zip.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repo, "bin/releaseflip.mjs");
const mode = process.argv[2] === "symlink" ? "symlink" : "rename";
const atomic = mode === "symlink";
const results = [];
let failed = 0;

const check = (name, condition, detail = "") => {
  results.push({ name, ok: Boolean(condition) });
  if (!condition) failed += 1;
  process.stdout.write(`  ${condition ? "✓" : "✗"} ${name}${!condition && detail ? `\n      ${detail}` : ""}\n`);
};

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

const write = async (path, contents) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
};

const run = (args, { token, cwd } = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: cwd || repo,
      env: { ...process.env, RELEASEFLIP_TOKEN: token ?? "" }
    });
    let output = "";
    child.stdout.on("data", (data) => (output += data));
    child.stderr.on("data", (data) => (output += data));
    child.on("close", (code) => resolve({ code, output }));
  });

const root = await mkdtemp(join(tmpdir(), "releaseflip-e2e-"));
const host = join(root, "home");
const docroot = join(host, "public_html");
const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const receiverUrl = `${base}/releaseflip.php`;
const token = randomBytes(32).toString("base64url");
const tokenHash = createHash("sha256").update(token).digest("hex");

await write(join(docroot, "index.html"), "original");
await write(join(docroot, ".htaccess"), "LIVE-HTACCESS");
await write(join(docroot, "config.php"), "<?php return 'live-config';");
await write(join(docroot, "brand/marks/logo.svg"), "LIVE-LOGO");
await write(join(docroot, "uploads/photo-1.jpg"), "PHOTO-1");
await copyFile(join(repo, "server/releaseflip.php"), join(docroot, "releaseflip.php"));
await write(
  join(host, mode === "rename" ? "releaseflip.public_html.config.php" : "releaseflip.config.php"),
  `<?php
return [
    'token_sha256' => '${tokenHash}',
    'docroot' => __DIR__ . '/public_html',
    'protect' => ['.htaccess', 'config.php', 'brand/marks/', 'uploads/'],
    'keep' => 3,
    'chunk_bytes' => 262144,
    'flip' => '${mode}',
];
`
);

const php = spawn("php", ["-S", `127.0.0.1:${port}`, "-t", docroot], {
  env: { ...process.env, PHP_CLI_SERVER_WORKERS: "4" },
  stdio: "ignore"
});

const get = async (path) => {
  try {
    const response = await fetch(`${base}${path}`, { cache: "no-store" });
    return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
  } catch {
    return { status: 0, body: Buffer.alloc(0) };
  }
};
const text = async (path) => (await get(path)).body.toString();
const disk = (path) => readFile(join(docroot, path), "utf8").catch(() => null);

for (let i = 0; i < 50 && (await get("/index.html")).status !== 200; i++) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const hammer = () => {
  const statuses = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      const { status, body } = await get("/index.html");
      statuses.push(status === 200 && body.length ? 200 : status);
    }
  })();
  return async () => {
    running = false;
    await loop;
    return { total: statuses.length, failures: statuses.filter((status) => status !== 200).length };
  };
};

const gap = (label, traffic) => {
  if (atomic) {
    check(`No failed page loads during ${label} (${traffic.total} requests)`, traffic.failures === 0, `${traffic.failures} failed`);
  } else {
    process.stdout.write(`  · During ${label}: ${traffic.failures} of ${traffic.total} page loads failed\n`);
  }
};

const release = async (name, files) => {
  const folder = join(root, name);
  for (const [path, contents] of Object.entries(files)) await write(join(folder, path), contents);
  return folder;
};

try {
  process.stdout.write(`\nreleaseflip end-to-end test (flip mode: ${mode})\n\n`);

  const big = randomBytes(3 * 1048576);
  const releaseA = await release("release-a", {
    "index.html": "release-A",
    ".htaccess": "REPO-HTACCESS",
    "brand/marks/logo.svg": "REPO-LOGO",
    "assets/app.js": "console.log('A')",
    "assets/big.bin": big,
    "node_modules/pkg/index.js": "excluded",
    ".DS_Store": "excluded"
  });

  process.stdout.write("Security\n");
  const receiverGet = await get("/releaseflip.php");
  check("Opening releaseflip.php in a browser is refused (405)", receiverGet.status === 405);
  const wrongToken = await run(["deploy", releaseA, "--url", receiverUrl], { token: "wrong" });
  check("A wrong token is rejected", wrongToken.code !== 0 && /wrong token/i.test(wrongToken.output), wrongToken.output);
  check("…and the site is unchanged", (await text("/index.html")) === "original");
  const noToken = await run(["deploy", releaseA, "--url", receiverUrl], { token: "" });
  check("A missing token stops the CLI before uploading", noToken.code !== 0 && /RELEASEFLIP_TOKEN/.test(noToken.output));
  const plainHttp = await run(["check", "--url", "http://example.com/releaseflip.php"], { token });
  check("The CLI refuses plain http:// for non-local servers", plainHttp.code !== 0 && /https/.test(plainHttp.output));

  process.stdout.write("\nFirst deploy\n");
  const checkRun = await run(["check", "--url", receiverUrl], { token });
  check("check connects and reports zip support", checkRun.code === 0 && /✓ PHP zip support/.test(checkRun.output), checkRun.output);
  let stop = hammer();
  const deployA = await run(["deploy", releaseA, "--url", receiverUrl], { token });
  let traffic = await stop();
  check("Deploy A succeeds (3 MB package, sent in 256 KB chunks)", deployA.code === 0 && /Live:/.test(deployA.output), deployA.output);
  process.stdout.write(`  · First flip: ${traffic.failures} of ${traffic.total} page loads failed (the one-time switch-over)\n`);
  check("New content is live", (await text("/index.html")) === "release-A");
  check("Large file arrives intact", createHash("sha256").update((await get("/assets/big.bin")).body).digest("hex") === createHash("sha256").update(big).digest("hex"));
  check("Live .htaccess was kept, not replaced by the repo copy", (await disk(".htaccess")) === "LIVE-HTACCESS");
  check("Live config.php was kept", (await disk("config.php")) === "<?php return 'live-config';");
  check("Live brand mark was kept, not replaced by the repo copy", (await disk("brand/marks/logo.svg")) === "LIVE-LOGO");
  check("Uploads folder carried across", (await disk("uploads/photo-1.jpg")) === "PHOTO-1");
  check("The receiver itself survived the flip", existsSync(join(docroot, "releaseflip.php")));
  check("node_modules and .DS_Store were left out", !existsSync(join(docroot, "node_modules")) && !existsSync(join(docroot, ".DS_Store")));
  check("The original site was kept as a rollback point", (await readdir(join(host, ".releaseflip-public_html/releases"))).some((id) => id.startsWith("original-")));

  process.stdout.write("\nSecond deploy\n");
  await write(join(docroot, "uploads/photo-2.jpg"), "PHOTO-2");
  const releaseB = await release("release-b", { "index.html": "release-B" });
  await new Promise((resolve) => setTimeout(resolve, 1100));
  stop = hammer();
  const deployB = await run(["deploy", releaseB, "--url", receiverUrl], { token });
  traffic = await stop();
  check("Deploy B succeeds", deployB.code === 0, deployB.output);
  gap("deploy B", traffic);
  check("B is live", (await text("/index.html")) === "release-B");
  check("Files removed from the build are gone", (await disk("assets/app.js")) === null && (await disk("assets/big.bin")) === null);
  check("A file uploaded on the server after deploy A survived", (await disk("uploads/photo-2.jpg")) === "PHOTO-2");
  const listing = await run(["list", "--url", receiverUrl], { token });
  check("list shows original, A and B with B live", (listing.output.match(/[●○]/g) || []).length === 3 && /● \S+ {2}\(live\)/.test(listing.output), listing.output);

  process.stdout.write("\nRollback\n");
  stop = hammer();
  const back1 = await run(["rollback", "--url", receiverUrl], { token });
  traffic = await stop();
  check("Rollback succeeds", back1.code === 0, back1.output);
  gap("rollback", traffic);
  check("A is live again", (await text("/index.html")) === "release-A");
  check("Protected files are still the live versions", (await disk(".htaccess")) === "LIVE-HTACCESS" && (await disk("uploads/photo-2.jpg")) === "PHOTO-2");
  const back2 = await run(["rollback", "--url", receiverUrl], { token });
  check("A second rollback steps back again, to the original site", back2.code === 0 && (await text("/index.html")) === "original", back2.output);
  check("…still with every protected file", (await disk(".htaccess")) === "LIVE-HTACCESS" && (await disk("uploads/photo-2.jpg")) === "PHOTO-2" && (await disk("brand/marks/logo.svg")) === "LIVE-LOGO");
  const back3 = await run(["rollback", "--url", receiverUrl], { token });
  check("Rolling back past the oldest release fails cleanly", back3.code !== 0 && /no earlier release/i.test(back3.output), back3.output);

  process.stdout.write("\nPruning\n");
  for (const name of ["c", "d", "e"]) {
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const folder = await release(`release-${name}`, { "index.html": `release-${name.toUpperCase()}` });
    const result = await run(["deploy", folder, "--url", receiverUrl], { token });
    if (result.code !== 0) check(`Deploy ${name.toUpperCase()}`, false, result.output);
  }
  const liveId = (await readFile(join(host, ".releaseflip-public_html/current"), "utf8")).trim();
  const kept = (await readdir(join(host, ".releaseflip-public_html/releases"))).filter((id) => !id.startsWith(".") && id !== liveId);
  check("keep: 3 leaves two older releases plus the original", kept.filter((id) => !id.startsWith("original-")).length === 2 && kept.some((id) => id.startsWith("original-")), kept.join(", "));
  check("E is live", (await text("/index.html")) === "release-E");

  process.stdout.write("\nBad packages\n");
  const client = createClient({ url: receiverUrl, token });
  const evil = createZip([
    { name: "index.html", data: Buffer.from("evil") },
    { name: "../escape.txt", data: Buffer.from("escaped") }
  ]);
  const traversal = await client.deploy(evil).then(() => null, (error) => error);
  check("A zip with ../ paths is rejected", traversal && /Rejected path/.test(traversal.message), traversal?.message);
  check("…nothing escaped the release folder", !existsSync(join(host, "escape.txt")) && !existsSync(join(host, ".releaseflip-public_html/escape.txt")));
  check("…and the live site is unchanged", (await text("/index.html")) === "release-E");

  const headers = { "X-Releaseflip-Token": token };
  const zip = createZip([{ name: "index.html", data: Buffer.from("tampered") }]);
  const begin = await (await fetch(`${receiverUrl}?action=begin`, { method: "POST", headers, body: JSON.stringify({ size: zip.length, sha256: "0".repeat(64) }) })).json();
  await fetch(`${receiverUrl}?action=chunk&upload=${begin.upload}&offset=0`, { method: "POST", headers, body: zip });
  const finish = await (await fetch(`${receiverUrl}?action=finish&upload=${begin.upload}`, { method: "POST", headers })).json();
  check("A corrupted upload is rejected by checksum", finish.error === "checksum_mismatch", JSON.stringify(finish));
  check("…and the live site is unchanged", (await text("/index.html")) === "release-E");

  process.stdout.write("\nSetup command\n");
  const setupDir = join(root, "setup-out");
  const setup = await run(["setup", setupDir]);
  const printedToken = (setup.output.match(/keep it secret\):\n\s+(\S+)/) || [])[1];
  const writtenConfig = await readFile(join(setupDir, "releaseflip.config.php"), "utf8").catch(() => "");
  check("setup writes both server files", existsSync(join(setupDir, "releaseflip.php")) && writtenConfig.length > 0);
  check("setup's config holds the hash of the printed token", Boolean(printedToken) && writtenConfig.includes(createHash("sha256").update(printedToken).digest("hex")));
} finally {
  php.kill();
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`\n${results.length - failed} passed, ${failed} failed\n\n`);
process.exit(failed ? 1 : 0);
