// 验证：①token 换 cookie ②cookie 跨热重载仍有效（无状态签名）③WS 带 cookie 101 且收带 method 帧
const TOKEN = "a776441024674c18988959905c057fa9";
const BASE = "http://127.0.0.1:46322";
// 模拟 LAN：带 x-dsh-mini-gateway:1（与手机经网关进来一致）
const LAN = { "x-dsh-mini-gateway": "1" };
async function main() {
  // ① GET /?token= → 302 + Set-Cookie
  const r1 = await fetch(BASE + "/?token=" + TOKEN, { redirect: "manual", headers: LAN });
  const setCookie = r1.headers.get("set-cookie") || "";
  console.log("step1 status=" + r1.status + " set-cookie? " + /dsh_mini_sid=/.test(setCookie));
  const sid = (setCookie.match(/dsh_mini_sid=([^;]+)/) || [])[1];
  if (!sid) throw new Error("no sid");

  // ② 带 cookie 再 GET / → 200 GUI（无 403）
  const r2 = await fetch(BASE + "/", { headers: { Cookie: "dsh_mini_sid=" + sid, ...LAN } });
  console.log("step2 status=" + r2.status + " hasBoot=" + /__DSH_BOOT__/.test(await r2.text()));

  // ③ 带 cookie 连 WS mux（Node 原生 WebSocket 无 headers 选项，改用子进程 curl 方式？——直接 HTTP 升级模拟）
  // Node 原生 WebSocket 支持 {headers} 吗？不支持。改用手动 upgrade 请求验证握手。
  const http = require("http");
  const { createHash } = require("crypto");
  const key = "dGhlIHNhbXBsZSBub25jZQ==";
  const path = "/api/events.mux";
  const req = http.request({
    host: "127.0.0.1", port: 46322, path, method: "GET",
    headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": key, Cookie: "dsh_mini_sid=" + sid, ...LAN },
  });
  const t = setTimeout(() => { console.log("TIMEOUT"); try { req.destroy(); } catch {} process.exit(1); }, 8000);
  req.on("upgrade", (res, socket) => {
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    console.log("ws UPGRADE 101? " + (res.headers["sec-websocket-accept"] === accept));
    // 读取服务端推送的首帧（subscribed 基线）
    let buf = Buffer.alloc(0);
    socket.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      // 帧头: FIN|opcode=0x81, 后 1 字节 len（<126）
      if (buf.length >= 2) {
        const len = buf[1] & 0x7f;
        if (buf.length >= 2 + len) {
          const payload = buf.slice(2, 2 + len).toString("utf8");
          const o = JSON.parse(payload);
          console.log("ws frame method=" + o.method + " payloadType=" + (o.payload && o.payload.type) + " keys=" + Object.keys(o).join(","));
          if (typeof o.method === "string" && o.payload && o.payload.type === "session/subscribed") {
            clearTimeout(t); socket.destroy(); process.exit(0);
          }
          console.log("BAD frame");
        }
      }
    });
    socket.on("error", (e) => console.log("socket ERR " + e.message));
  });
  req.on("error", (e) => console.log("req ERR " + e.message));
  req.end();
}
main().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });