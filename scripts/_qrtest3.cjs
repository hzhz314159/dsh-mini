const fs = require("node:fs");
const src = fs.readFileSync("E:/DSH Zone/dsh-mini/lib/client.js", "utf8");
const start = src.indexOf("var qrcode = (function () {");
const end = src.indexOf("})();", start + 10);
const block = src.slice(start, end + 5);
const getQr = new Function(block + ";\nreturn qrcode;");
const qrcode = getQr();
console.log("typeof qrcode =", typeof qrcode);
if (typeof qrcode === "function") {
  const q = qrcode(0, "M");
  q.addData("http://192.168.1.5:46322/dsh-mini/?token=abc123");
  q.make();
  console.log("modules =", q.getModuleCount(), "isDark(0,0) =", q.isDark(0, 0));
} else {
  console.log("keys =", Object.keys(qrcode));
}
