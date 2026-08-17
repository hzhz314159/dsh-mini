// assemble-client.cjs — 把 vendor/qrcode.js（MIT, Kazuhiko Arase）内联进
// src/client.js 模板，产出 lib/client.js。零参数、相对路径，避免 PS 5.1
// 向原生命令传参时的引号重解析坑。
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const repo = path.resolve(__dirname, "..");
const tplPath = path.join(repo, "src", "client.js");
const qrPath = path.join(repo, "vendor", "qrcode.js");
const outPath = path.join(repo, "lib", "client.js");

const tpl = fs.readFileSync(tplPath, "utf8");
const qr = fs.readFileSync(qrPath, "utf8");
if (!tpl.includes("/*__QRCODE_LIB__*/")) {
  console.error("marker /*__QRCODE_LIB__*/ missing in src/client.js");
  process.exit(1);
}
// 用 split/join 而非 replace：qr 内容含 `$'`（如 `case '$'`），
// String.replace 会把替换串里的 $ 序列当特殊模式展开，破坏产物。
fs.writeFileSync(outPath, tpl.split("/*__QRCODE_LIB__*/").join(qr), "utf8");
console.log("assembled lib/client.js (" + Buffer.byteLength(fs.readFileSync(outPath, "utf8")) + " bytes)");
