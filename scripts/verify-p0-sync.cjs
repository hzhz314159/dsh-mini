// dsh-mini P0 同步修复验证 —— 桌面端新建会话 → 手机端 WS host 流是否收到两帧
//   ① host/session-added（带 header.cwd，用于前端分组）
//   ② host/workspace-changed（workspace.sessionIds 更新）
// 流程：连接 /api/events.host?token= → RPC session.create(临时cwd) → 收集帧 → 断言
//       → 清理（workspace.deleteSession + 删临时目录）
// 用法：node scripts/verify-p0-sync.cjs [gatewayPort] [token]
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const port = Number(process.argv[2] || "46322");
const token =
  process.argv[3] ||
  (fs.existsSync(path.join(os.homedir(), ".dsh", "dsh-mini", "token.txt"))
    ? fs.readFileSync(path.join(os.homedir(), ".dsh", "dsh-mini", "token.txt"), "utf8").trim()
    : "");
if (!token) { console.error("no token"); process.exit(2); }

const tmpCwd = path.join(os.homedir(), ".dsh", "dsh-mini", ".p0-sync-test");
let pass = 0, fail = 0;
function ok(n, c, d) { c ? (pass++, console.log(`PASS  ${n} : ${d}`)) : (fail++, console.log(`FAIL  ${n} : ${d}`)); }

function httpOnce(opt, body) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, ...opt }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: d }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.message }));
    if (body) r.write(body);
    r.end();
  });
}

let sidCookie = "";
// 模拟手机端首跳：GET /?token= → 302 签发 dsh_mini_sid 30 天 cookie
async function bootstrapCookie() {
  const res = await httpOnce({ path: "/?token=" + encodeURIComponent(token), method: "GET" });
  const sc = res.headers && (res.headers["set-cookie"] || "");
  const m = /dsh_mini_sid=([^;]+)/.exec(Array.isArray(sc) ? sc[0] || "" : String(sc || ""));
  if (m) sidCookie = "dsh_mini_sid=" + m[1];
  return sidCookie;
}

async function rpc(method, payload) {
  const body = JSON.stringify({ type: "client-request", rpcId: "t-" + Date.now(), method, payload });
  // 用首跳换的 dsh_mini_sid cookie（POST + ?token= 会被 authGuiRequest 302 换 cookie，故不能走 query）
  const opt = {
    path: "/api/" + method,
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body), ...(sidCookie ? { Cookie: sidCookie } : {}) },
  };
  const res = await httpOnce(opt, body);
  if (res.status && res.status >= 200 && res.status < 300) {
    try { return JSON.parse(res.body); } catch { return { error: res.body.slice(0, 200) }; }
  }
  return { httpStatus: res.status, error: res.body.slice(0, 160), headers: res.headers };
}

// 极简 WS 客户端：握手 + 只收服务器文本帧（解析长度）。
// 返回 { frames: 共享数组, done: Promise } — 先 startCollect 启动收集，做 RPC/操作后再 await done
// 收口（避免 await 阻塞导致会话操作发生在 socket 销毁之后 = 帧永远到不了 的时序坑）。
function startCollect(pathStr, durationMs) {
  const frames = [];
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  let buf = Buffer.alloc(0);
  const s = net.connect(port, "127.0.0.1", () => {
    s.write(`GET ${pathStr} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  });
  let got101 = false;
  s.on("data", (chunk) => {
    if (!got101) {
      const idx = chunk.indexOf("\r\n\r\n");
      if (idx === -1) return;
      const head = chunk.slice(0, idx).toString();
      if (!/ 101 /.test(head)) { resolveDone({ error: head.split("\r\n")[0], frames }); s.destroy(); return; }
      got101 = true;
      buf = chunk.slice(idx + 4);
    } else {
      buf = Buffer.concat([buf, chunk]);
    }
    // 解析帧
    while (buf.length >= 2) {
      const finOp = buf[0];
      const isText = (finOp & 0x0f) === 1;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) break;
      let payload = buf.slice(off + maskLen, off + maskLen + len);
      if (masked) { const m = buf.slice(off, off + 4); payload = Buffer.from(payload.map((b, i) => b ^ m[i % 4])); }
      if (isText) { try { frames.push(JSON.parse(payload.toString("utf8"))); } catch {} }
      buf = buf.slice(off + maskLen + len);
    }
  });
  s.on("error", () => resolveDone({ error: "socket error", frames }));
  setTimeout(() => { try { s.destroy(); } catch {} resolveDone({ frames }); }, durationMs);
  return { frames, done };
}

(async () => {
  console.log(`port=${port} token=${token.slice(0, 6)}… tmpCwd=${tmpCwd}\n`);

  // 先启动 WS 收集（共享帧数组，不 await 阻塞），再做 RPC，最后 await done 收口。
  // 时序教训：await wsCollect 会挂起 8s，导致会话操作发生在 socket 销毁后 → 帧永远到不了。
  const wc = startCollect("/api/events.host?token=" + encodeURIComponent(token), 8000);
  await new Promise((r) => setTimeout(r, 400)); // 等握手完成
  const { frames } = wc;
  if (frames.length && frames[0] && frames[0].error) { console.error("WS 连接失败:", frames[0].error); process.exit(1); }

  // 先换 cookie（POST RPC 走 cookie 鉴权；POST+?token= 会被 302）
  const cookieOk = await bootstrapCookie();
  ok("模拟首跳：?token= → 会话 cookie", !!cookieOk, cookieOk ? cookieOk.slice(0, 24) + "…" : "无 Set-Cookie");

  // 触发：优先用真实 workspace 的 path 建会话（验证 domain/changed → workspace-changed.sessionIds 增量）
  // 无 workspace 时 fallback 临时 cwd（只验证 session-added 带 cwd）
  let wsPath = null, wsId = null;
  try {
    const wl = await rpc("workspace.list", {});
    const arr = wl && wl.result && wl.result.ok && Array.isArray(wl.result.value) ? wl.result.value : [];
    const first = arr.find((w) => w && w.path && !/\.p0-sync-test/.test(w.path));
    if (first) { wsPath = first.path; wsId = first.workspaceId || first.id; }
  } catch {}
  const createCwd = wsPath || tmpCwd;
  try { fs.mkdirSync(createCwd, { recursive: true }); } catch {}
  const created = await rpc("session.create", { cwd: createCwd });
  const sid = created.result && created.result.ok && created.result.value ? created.result.value.sessionId || created.result.value.id : null;
  ok("session.create 成功", !!sid, created.result && created.result.ok ? `sessionId=${sid} cwd=${createCwd}` : JSON.stringify(created).slice(0, 160));
  if (!sid) process.exit(2);

  // 等增量帧到达（WS 仍打开）
  await new Promise((r) => setTimeout(r, 2000));

  const added = frames.filter((f) => f && f.payload && f.payload.type === "host/session-added" && f.payload.sessionId === sid);
  ok("收到 host/session-added（含新会话）", added.length > 0, added.length ? `cwd=${added[0].payload.cwd}` : "无该帧");
  if (added.length) ok("session-added 带 cwd(from header)", !!added[0].payload.cwd, "cwd=" + added[0].payload.cwd);

  const wcFrames = frames.filter((f) => f && f.payload && f.payload.type === "host/workspace-changed");
  ok("收到 host/workspace-changed", wcFrames.length > 0, `共 ${wcFrames.length} 个 workspace-changed 帧`);
  if (wsId && wsPath) {
    const wcHit = wcFrames.filter((f) => f.payload.workspace && f.payload.workspace.workspaceId === wsId && (f.payload.workspace.sessionIds || []).includes(sid));
    ok(`workspace(${wsId}).sessionIds 含新会话（domain/changed→workspace-changed 增量）`, wcHit.length > 0,
      wcHit.length ? JSON.stringify(wcHit[wcHit.length - 1].payload.workspace).slice(0, 160) : `未见 workspace-changed 增量帧（cwd=${wsPath}）`);
  } else {
    ok("workspace.sessionIds 含新会话（无 workspace，跳过）", true, "无真实 workspace，跳过增量断言（仅验证 session-added）");
  }

  // 清理：删除测试会话 + 临时目录
  const del = await rpc("workspace.deleteSession", { sessionId: sid }).catch(() => null);
  ok("清理：workspace.deleteSession", !!(del && del.result && del.result.ok), JSON.stringify(del && del.result).slice(0, 120));
  try { fs.rmSync(tmpCwd, { recursive: true, force: true }); } catch {}

  // 会话删除应推 host/session-removed（WS 仍打开）
  await new Promise((r) => setTimeout(r, 1200));
  const removed = frames.filter((f) => f && f.payload && f.payload.type === "host/session-removed" && f.payload.sessionId === sid);
  ok("清理：收到 host/session-removed", removed.length > 0, removed.length ? "session-removed" : "无移除帧");

  await wc.done; // 收口（等窗口结束，socket 销毁）
  console.log(`帧摘要: ${frames.map((f) => (f && f.payload && f.payload.type) || (f && f.type) || "?").join(", ")}`);

  console.log(`\nRESULT: ${fail === 0 ? "PASS" : "FAIL"} (${pass} pass, ${fail} fail)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error("ERR:", e); process.exit(2); });
