// dsh-mini SPEC-v5 §2 「允许外网访问」开关 —— 专项验证
// 集成断言（行为级）：通过网关实际行为验证 Host 头来源判定 + publicMode 语义。
// 1) 关闭模式（publicMode=false，仅局域网）：回环/LAN/私有IP → 200；公网域名/公网IP/自定义域名 → 403（含带 token、含 WS、含 /api/ping、含 /dsh-mini/* 反代路径前）
// 2) 开启模式（publicMode=true，允许外网）：一律强制 token；公网+token → 302/200
// 用法：node scripts/test-allow-external.cjs [gatewayPort] [token]
// 注意：会临时改写 ~/.dsh/dsh-mini/config.json（关/开 publicMode），结束自动还原原状态。
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const home = path.join(os.homedir(), ".dsh", "dsh-mini");
const cfgFile = path.join(home, "config.json");
const port = process.argv[2] || "46322";
const token = process.argv[3] || (fs.existsSync(path.join(home, "token.txt")) ? fs.readFileSync(path.join(home, "token.txt"), "utf8").trim() : "");

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name} : ${detail}`); }
  else { fail++; console.log(`FAIL  ${name} : ${detail}`); }
}

function readCfg() { try { return JSON.parse(fs.readFileSync(cfgFile, "utf8")); } catch { return {}; } }
function writeCfg(c) { fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2)); }
const orig = readCfg();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 自定义 Host 头请求（setHost:false 允许覆盖 Host）
function req(hostHeader, p, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve) => {
    const h = { ...headers };
    if (hostHeader) h.Host = hostHeader;
    const r = http.request(
      { host: "127.0.0.1", port: Number(port), path: p, method, headers: h, setHost: false },
      (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(`${res.statusCode}|${d.slice(0, 120).replace(/\n/g, " ")}`));
      }
    );
    r.on("error", (e) => resolve("ERR|" + e.message));
    r.end();
  });
}
// 原始 socket 发 WS upgrade（自定义 Host）
function wsUpgrade(hostHeader, pathStr = "/api/events.host") {
  return new Promise((resolve) => {
    const s = net.connect(Number(port), "127.0.0.1", () => {
      s.write(
        `GET ${pathStr} HTTP/1.1\r\nHost: ${hostHeader}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
      );
    });
    let d = "";
    const done = (v) => { try { s.destroy(); } catch {} resolve(v); };
    s.on("data", (x) => {
      d += x.toString();
      if (d.includes("403") || d.includes("101")) done(d.split("\r\n")[0]);
    });
    s.on("error", () => done("ERR"));
    setTimeout(() => done("timeout|" + (d.split("\r\n")[0] || "none")), 3000);
  });
}

async function main() {
  const lanIp = (() => {
    try {
      const ifs = os.networkInterfaces();
      for (const k of Object.keys(ifs)) for (const n of ifs[k] || [])
        if (n.family === "IPv4" && !n.internal) return n.address;
    } catch {}
    return "192.168.2.3";
  })();
  console.log(`port=${port} token=${token ? token.slice(0, 6) + "…" : "(空)"}\n`);

  console.log("===== 关闭模式（publicMode=false → 仅局域网）=====");
  writeCfg({ ...orig, publicMode: false });
  await sleep(5200); // loadConfig 5s 缓存过期

  const d = {};
  d.loopback = await req(`127.0.0.1:${port}`, "/api/ping");          ok("关闭/回环IP ping 200", d.loopback.startsWith("200"), d.loopback);
  d.localhost = await req("localhost", "/api/ping");                  ok("关闭/localhost ping 200", d.localhost.startsWith("200"), d.localhost);
  d.lan = await req(lanIp, "/api/ping");                              ok("关闭/LAN IP ping 200", d.lan.startsWith("200"), d.lan);
  d.priv = await req("192.168.1.50", "/api/ping");                    ok("关闭/同段私有IP ping 200", d.priv.startsWith("200"), d.priv);
  d.ten = await req("10.1.2.3", "/api/ping");                         ok("关闭/10.x 私有 ping 200", d.ten.startsWith("200"), d.ten);
  d.v6ll = await req("[fe80::1]", "/api/ping");                       ok("关闭/IPv6链路本地 ping 200", d.v6ll.startsWith("200"), d.v6ll);
  d.v6ula = await req("[fd00::1]", "/api/ping");                      ok("关闭/IPv6 ULA ping 200", d.v6ula.startsWith("200"), d.v6ula);
  d.tunnel = await req("xxx-xxx.trycloudflare.com", "/api/ping");     ok("关闭/公网隧道域名 403", d.tunnel.startsWith("403"), d.tunnel);
  d.pubip = await req("8.8.8.8", "/api/ping");                        ok("关闭/公网IP 403", d.pubip.startsWith("403"), d.pubip);
  d.domain = await req("my.custom.dsh.cc", "/api/ping");              ok("关闭/自定义域名 403", d.domain.startsWith("403"), d.domain);

  const droot = await req("xxx-xxx.trycloudflare.com", "/");          ok("关闭/公网Host根路径 403", droot.startsWith("403"), droot);
  const dlegacy = await req("xxx-xxx.trycloudflare.com", "/dsh-mini/api/health"); ok("关闭/公网Host旧协议反代前 403", dlegacy.startsWith("403"), dlegacy);
  const dtok = await req("xxx-xxx.trycloudflare.com", `/?token=${encodeURIComponent(token)}`); ok("关闭/公网Host带token仍403", dtok.startsWith("403"), dtok);
  const drpc = await req("xxx-xxx.trycloudflare.com", "/api/session.list", { method: "POST", headers: { "Content-Type": "application/json" } }); ok("关闭/公网Host RPC 403", drpc.startsWith("403"), drpc);

  const wsExt = await wsUpgrade("xxx-xxx.trycloudflare.com");          ok("关闭/WS公网Host被拒403", /403/.test(wsExt), wsExt);
  const wsLoc = await wsUpgrade("localhost");                          ok("关闭/WS回环localhost 101", /101/.test(wsLoc), wsLoc);

  console.log("\n===== 开启模式（publicMode=true → 允许外网，强制 token）=====");
  writeCfg({ ...orig, publicMode: true });
  await sleep(5200);

  const o = {};
  o.pub = await req("xxx-xxx.trycloudflare.com", "/api/base");        ok("开启/公网无token /api/base 403", o.pub.startsWith("403"), o.pub);
  o.lan = await req(lanIp, "/api/base");                              ok("开启/LAN无token /api/base 403", o.lan.startsWith("403"), o.lan);
  o.loop = await req("127.0.0.1", "/api/base");                       ok("开启/回环无token /api/base 403(取消豁免)", o.loop.startsWith("403"), o.loop);
  const oTok = await req("xxx-xxx.trycloudflare.com", `/api/base?token=${encodeURIComponent(token)}`); ok("开启/公网+token→302|200", /^(302|200)/.test(oTok), oTok);
  const oWsTok = await wsUpgrade("xxx-xxx.trycloudflare.com", `/api/events.host?token=${encodeURIComponent(token)}`); ok("开启/WS公网+token 101", /101/.test(oWsTok), oWsTok);
  const oWsNo = await wsUpgrade("xxx-xxx.trycloudflare.com");          ok("开启/WS公网无token 403", /403/.test(oWsNo), oWsNo);

  // 还原
  writeCfg(orig);
  console.log(`\n还原 config.json → publicMode=${orig.publicMode} publicUrl=${orig.publicUrl || "(空)"}`);
  console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass} pass, ${fail} fail)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERR:", e); process.exit(2); });
