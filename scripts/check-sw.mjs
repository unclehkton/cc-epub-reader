/**
 * Fail if the built service worker does not carry a build id.
 *
 * The id must change on every build. If `sw.js` is byte-identical between two
 * deploys, an installed PWA never sees a new worker, so it keeps serving the
 * document and headers it cached at install time. That is exactly how a
 * `public/_headers`-only release stayed invisible on the phone.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const swPath = path.join(root, "dist", "sw.js");
const indexPath = path.join(root, "dist", "index.html");

function fail(message) {
  console.error(`check-sw: ${message}`);
  process.exit(1);
}

if (!fs.existsSync(swPath)) {
  fail("dist/sw.js not found. Run npm run build first.");
}

if (!fs.existsSync(indexPath)) {
  fail("dist/index.html not found. Run npm run build first.");
}

const source = fs.readFileSync(swPath, "utf8");
const html = fs.readFileSync(indexPath, "utf8");

if (source.includes("__BUILD_ID__")) {
  fail("dist/sw.js still contains the literal __BUILD_ID__ token: the Vite define did not apply.");
}

const id = html.match(/<meta name="build-id" content="([^"]+)"/)?.[1];
if (!id) {
  fail("dist/index.html has no <meta name=\"build-id\"> tag.");
}

if (!/^[A-Za-z0-9._-]+$/.test(id)) {
  fail(`build id ${JSON.stringify(id)} is not a single safe token.`);
}

if (!source.includes(id)) {
  fail(
    `dist/sw.js does not embed the build id ${id}. Check that src/sw.ts reads __BUILD_ID__ and that vite.config.ts defines it for the service worker build.`,
  );
}

console.log(`check-sw: sw.js build id ${id} (${source.length} bytes)`);
