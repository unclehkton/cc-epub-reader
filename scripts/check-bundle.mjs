/**
 * Fail if the gzip size of entry JS/CSS linked from dist/index.html
 * exceeds the initial-shell budget (150 KiB). Lazy EPUB.js / OpenCC chunks
 * are reported separately and do not count toward the shell budget.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist");
const indexPath = path.join(distDir, "index.html");
const BUDGET = 153_600;

if (!fs.existsSync(indexPath)) {
  console.error("check-bundle: dist/index.html not found. Run npm run build first.");
  process.exit(1);
}

const html = fs.readFileSync(indexPath, "utf8");
const linked = new Set();
for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/g)) {
  const href = match[1];
  if (!href) continue;
  // Only initial shell assets under /assets that are JS or CSS.
  if (!/\.(js|css)(?:\?|$)/i.test(href)) continue;
  if (href.startsWith("http:") || href.startsWith("https:") || href.startsWith("//")) {
    continue;
  }
  linked.add(href);
}

function resolveAsset(href) {
  const cleaned = href.replace(/^\//, "");
  return path.join(distDir, cleaned);
}

function gzipSize(filePath) {
  const raw = fs.readFileSync(filePath);
  return zlib.gzipSync(raw, { level: 9 }).length;
}

const assetsDir = path.join(distDir, "assets");
const allAssets = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).filter((name) => /\.(js|css)$/i.test(name))
  : [];

let shellTotal = 0;
const shellRows = [];

for (const href of [...linked].sort()) {
  const filePath = resolveAsset(href);
  if (!fs.existsSync(filePath)) {
    console.error(`check-bundle: missing linked asset ${href}`);
    process.exit(1);
  }
  const size = gzipSize(filePath);
  shellTotal += size;
  shellRows.push({ href, size });
}

const lazyRows = [];
for (const name of allAssets) {
  const href = `/assets/${name}`;
  if (linked.has(href) || [...linked].some((h) => h.endsWith(`/${name}`) || h.endsWith(name))) {
    continue;
  }
  const size = gzipSize(path.join(assetsDir, name));
  lazyRows.push({ href, size, name });
}

// Classify lazy chunks by heuristic names.
function classify(name) {
  const lower = name.toLowerCase();
  if (lower.includes("epub")) {
    return "epubjs";
  }
  if (
    lower.includes("opencc") ||
    lower.startsWith("full-") ||
    lower.includes("cn-") ||
    /(?:^|-)(?:hk|tw|t)[-.]/.test(lower)
  ) {
    // opencc-js often emits dictionary chunks like full-*.js
    return "opencc-related";
  }
  // Vite may name the epubjs async chunk after the importer path (src-*.js).
  if (lower.startsWith("src-") && lower.endsWith(".js")) {
    return "epubjs-related";
  }
  return "other-lazy";
}

console.log("Initial shell (linked from index.html):");
for (const row of shellRows) {
  console.log(`  ${row.href}  gzip ${row.size} bytes`);
}
console.log(`  TOTAL shell gzip: ${shellTotal} bytes (budget ${BUDGET})`);

console.log("\nLazy chunks (not in shell budget):");
if (lazyRows.length === 0) {
  console.log("  (none)");
} else {
  for (const row of lazyRows.sort((a, b) => b.size - a.size)) {
    console.log(`  ${row.href}  gzip ${row.size} bytes  [${classify(row.name)}]`);
  }
}

if (shellTotal > BUDGET) {
  console.error(
    `\ncheck-bundle: FAIL shell ${shellTotal} > ${BUDGET} bytes gzip`,
  );
  process.exit(1);
}

console.log(`\ncheck-bundle: OK shell ${shellTotal} <= ${BUDGET} bytes gzip`);
