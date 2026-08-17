// /api/verify-ws-browser.cjs — 完全模拟手机 WebView 浏览器 WS 握手（带 Origin + cookie + UA）
const net = require("node:net");
const crypto = require("node:crypto");
const HOST = "127.0.0.1";
const PORT = 46322;

function tryHandshake(label, headers, path) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST, () => {
      const key = crypto.randomBytes(16).toString("base64");
      let req = `GET ${path || "/api/events.mux"} HTTP/1.1\r\nHost: 192.168.2.3:46322\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n`;
      for (const [k, v] of Object.entries(headers)) req += k + ": " + v + "\r\n";
      req += "\r\n";
      sock.write(req);
    });
    let buf = "";
    const timer = setTimeout(() => { console.log(label, "=> TIMEOUT"); sock.destroy(); resolve(); }, 3000);
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        clearTimeout(timer);
        console.log(label, "=>", buf.split("\r\n\r\n")[0].split("\r\n")[0]);
        sock.destroy();
        resolve();
      }
    });
    sock.on("error", (e) => { clearTimeout(timer); console.log(label, "=> ERR", e.message); resolve(); });
  });
}

(async () => {
  const ua = "Mozilla/5.0 (Linux; Android 10; CDY-AN00 Build/HUAWEICDY-AN00) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/89.0.4389.105 Mobile Safari/537.36 DSHMiniApp/1.3.1";
  await tryHandshake("浏览器头(无cookie)", { "User-Agent": ua, Origin: "http://192.168.2.3:46322", "Accept-Encoding": "gzip, deflate", "Accept-Language": "zh-CN,zh;q=0.9" });
  await tryHandshake("浏览器头+有效格式cookie", { "User-Agent": ua, Origin: "http://192.168.2.3:46322", Cookie: "dsh_mini_sid=abc123def456" });
  await tryHandshake("host=192.168.2.3 非法Host无Origin", { "User-Agent": ua });
  process.exit(0);
})();