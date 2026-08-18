// update-manifest-revs.cjs — 重算 gui/bundles 全部 client.js 的 sha1(12) 并更新 manifest.json entries 的 rev/url
// 用途：bundle 内容被修改后（如 isLoopback 修复），rev 必须变，否则 WebView 缓存命中旧 bundle
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const GUI_DIR = path.join(__dirname, "..", "gui");
const BUNDLES = path.join(GUI_DIR, "bundles");
const MANIFEST = path.join(GUI_DIR, "manifest.json");

const sha12 = (buf) => crypto.createHash("sha1").update(buf).digest("hex").slice(0, 12);

const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
let changed = 0;
let maxRev = "";
for (const entry of manifest.entries) {
  const file = path.join(BUNDLES, entry.id, "client.js");
  if (!fs.existsSync(file)) {
    console.log("MISSING:", entry.id);
    continue;
  }
  const buf = fs.readFileSync(file);
  const rev = sha12(buf);
  if (entry.rev !== rev) {
    console.log(`rev-change ${entry.id}: ${entry.rev} -> ${rev}`);
    entry.rev = rev;
    entry.url = `/plugins/${entry.id}/client.js?rev=${rev}`;
    changed++;
  }
  if (rev > maxRev) maxRev = rev;
}
// 顶层 rev：若任一 entry 变化则沿用 map 全部 rev 组合的哈希（保证全局变化）
if (changed > 0) {
  const all = manifest.entries.map((e) => e.rev).join(",");
  manifest.rev = sha12(Buffer.from(all));
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2), "utf8");
  console.log(`top-rev -> ${manifest.rev} (${changed} entries changed)`);
} else {
  console.log("no entry changed (revs already current), top-rev stays", manifest.rev);
}