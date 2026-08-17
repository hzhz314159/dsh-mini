// /api/verify-ws-handshake.cjs — 模拟 LAN 客户端 WS 握手（带 gateway 头 + cookie + token），
// 观察网关 upgrade 处理是否正确返回 101
const net = require("node:net");
const crypto = require("node:crypto");

const HOST = "127.0.0.1";
const PORT = 46322;

function tryHandshake(label, headers) {
  return new Promise((resolve) => {
    const sock = net.connect(PORT, HOST, () => {
      let req = "GET /api/events.mux HTTP/1.1\r\nHost: 192.168.2.3:46322\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + crypto.randomBytes(16).toString("base64") + "\r\nSec-WebSocket-Version: 13\r\n";
      for (const [k, v] of Object.entries(headers)) req += k + ": " + v + "\r\n";
      req += "\r\n";
      sock.write(req);
    });
    let buf = "";
    const timer = setTimeout(() => {
      console.log(label, "=> TIMEOUT (无响应)");
      sock.destroy();
      resolve();
    }, 3000);
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      if (buf.includes("\r\n\r\n")) {
        clearTimeout(timer);
        const head = buf.split("\r\n\r\n")[0];
        console.log(label, "=>", head.split("\r\n")[0]);
        sock.destroy();
        resolve();
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      console.log(label, "=> ERR", e.message);
      resolve();
    });
  });
}

(async () => {
  await tryHandshake("无凭据", {});
  await tryHandshake("仅 cookie 会话", { Cookie: "dsh_mini_sid=" + crypto.randomUUID().replace(/-/g, "") });
  await tryHandshake("仅 token 参数", { "x-dsh-mini-gateway": "1" }, );
  // 需要带 gateway 头来绕开 isLoopback 的免鉴权判定，模拟 LAN
  await tryHandshake("gateway+无凭据", { "x-dsh-mini-gateway": "1" });
  await tryHandshake("gateway+cookie", { "x-dsh-mini-gateway": "1", Cookie: "dsh_mini_sid=" + crypto.randomUUID().replace(/-/g, "") });
  process.exit(0);
})();