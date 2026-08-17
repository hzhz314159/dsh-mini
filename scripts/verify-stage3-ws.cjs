// verify-stage3-ws.cjs — 阶段3 WS 下推流验证（Node 原生 WebSocket 客户端）
// 用法：node verify-stage3-ws.cjs
// 验证：①mux 握手 + 收到 session/subscribed 基线 ②帧信封 server-request 形状
//      ③（可选）session/event 帧 ④host 握手 + workspace 快照
const BASE = "http://127.0.0.1:46322";
let pass = 0, fail = 0;
const check = (ok, name) => {
  if (ok) { pass++; console.log("[PASS] " + name); }
  else { fail++; console.log("[FAIL] " + name); }
};

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
    ws.onclose = (e) => reject(new Error("ws closed code=" + e.code));
    setTimeout(() => reject(new Error("ws open timeout")), 8000);
  });
}

// 收集帧知道 predicate 满足或超时；timeout 时返回已收帧（不抛）
function collectFrames(ws, predicate, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const frames = [];
    const timer = setTimeout(() => resolve({ frames, done: false }), timeoutMs);
    ws.onmessage = (m) => {
      let p;
      try { p = JSON.parse(m.data); } catch { return; }
      frames.push(p);
      if (predicate(p)) {
        clearTimeout(timer);
        resolve({ frames, done: true });
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve({ frames, done: false });
    };
  });
}

async function main() {
  // 1) mux 流
  try {
    const ws = await wsOpen(BASE + "/api/events.mux");
    const { frames, done } = await collectFrames(ws, (f) => f.payload && f.payload.type === "session/subscribed");
    ws.close();
    check(done, "mux: 收到 session/subscribed 基线");
    const sub = frames.find((f) => f.payload && f.payload.type === "session/subscribed");
    check(
      !!sub && sub.type === "server-request" && typeof sub.payload.sessionId === "string" && typeof sub.payload.lastSeq === "number",
      "mux: subscribed 帧形状（server-request 信封 + sessionId + lastSeq 数值）",
    );
    check(frames.every((f) => f.type === "server-request"), "mux: 所有帧均为 server-request 信封");
    const ev = frames.find((f) => f.payload && f.payload.type === "session/event");
    if (ev) {
      check(!!(ev.payload.event && ev.payload.event.type) && typeof ev.payload.sessionId === "string", "mux: session/event 帧形状");
    } else {
      console.log("[INFO] mux: 收集窗口内无 session/event 增量（正常，无活跃事件）");
    }
  } catch (e) {
    check(false, "mux 连接失败: " + e.message);
  }

  // 2) host 流
  try {
    const ws = await wsOpen(BASE + "/api/events.host");
    const { frames, done } = await collectFrames(ws, (f) => f.payload && f.payload.type === "host/workspace-changed", 8000);
    ws.close();
    check(done, "host: 收到 workspace-changed 快照");
    check(frames.every((f) => f.type === "server-request"), "host: 所有帧均为 server-request 信封");
  } catch (e) {
    check(false, "host 连接失败: " + e.message);
  }

  console.log(`\n===== stage3 ws: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("[FAIL] unhandled: " + e.message);
  process.exitCode = 1;
});