import { lstat, readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";

export const DEFAULT_EXCLUDE = [".git/", "node_modules/", ".DS_Store", ".env", "releaseflip.json", "releaseflip-server/"];

const toRegex = (pattern) => {
  const directory = pattern.endsWith("/");
  const body = pattern
    .replace(/\/$/, "")
    .replace(/^\.\//, "")
    .split("*")
    .map((piece) => piece.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  const anchored = pattern.includes("/") && !/^[^/]*\/$/.test(pattern) ? `^${body}` : `(^|/)${body}`;
  return new RegExp(directory ? `${anchored}(/|$)` : `${anchored}$`);
};

export async function collectFiles(root, exclude = []) {
  const rules = [...DEFAULT_EXCLUDE, ...exclude].map(toRegex);
  const skipped = [];
  const files = [];

  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      const probe = entry.isDirectory() ? `${path}/` : path;
      if (rules.some((rule) => rule.test(probe) || rule.test(path))) continue;
      if (entry.isSymbolicLink()) {
        skipped.push(path);
        continue;
      }
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        files.push({ name: path, data: await readFile(absolute), mtime: info.mtime });
      }
    }
  };

  await walk(root);
  return { files, skipped };
}
