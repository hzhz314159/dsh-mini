// verify-stage3-live.cjs — 阶段3 增量帧端到端：连 mux → 发 prompt → 收 session/event 增量
// 验证 ctx.on('session/event') 接线与帧形状（agent 入队 + assistant 回复事件）
const BASE = "http://127.0.0.1:46322";
let pass = 0, fail = 0;
const check = (ok, name) => {
  if (ok) { pass++; console.log("[PASS] " + name); }
  else { fail++; console.log("[FAIL] " + name); }
};

function post(path, body) {
  return fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then((r) => r.json());
}

function wsOpen(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("ws error"));
    ws.onclose = (e) => reject(new Error("ws closed code=" + e.code));
    setTimeout(() => reject(new Error("ws open timeout")), 8000);
  });
}

async function main() {
  // 新建干净会话（避免旧会话残留 prompt 队列干扰；贴近 GUI 流程）
  const created = await post("/api/session.create", {
    type: "client-request",
    rpcId: "c-" + Date.now(),
    method: "session.create",
    payload: { cwd: "E:/DSH Zone" },
  });
  const sessionId = created.result && created.result.ok && created.result.value && created.result.value.sessionId;
  check(typeof sessionId === "string" && sessionId.startsWith("session-"), "session.create: 拿到新会话 id");
  console.log("[INFO] 使用会话:", sessionId);
  if (!sessionId) process.exit(1);
  const ws = await wsOpen(BASE + "/api/events.mux");

  // 先挂收集 handler，再发 prompt（避免事件在监听挂上前被丢弃）
  const frames = [];
  let eventDone = false, asstDone = false;
  let eventTimer, asstTimer;
  let resolveEvent, resolveAsst;
  const eventArrived = new Promise((res) => (resolveEvent = res));
  const asstArrived = new Promise((res) => (resolveAsst = res));
  ws.onmessage = (m) => {
    let p;
    try { p = JSON.parse(m.data); } catch { return; }
    if (p.payload && p.payload.type === "session/event" && p.payload.sessionId === sessionId) {
      frames.push(p.payload.event);
      const t1 = p.payload.event.type;
      console.log("[INFO] 增量事件:", t1);
      if (!eventDone) {
        eventDone = true;
        clearTimeout(eventTimer);
        resolveEvent(true);
      }
      if ((t1 === "assistant/message" || t1 === "assistant/chunk" || t1 === "turn/end") && !asstDone) {
        asstDone = true;
        clearTimeout(asstTimer);
        resolveAsst(true);
      }
    }
  };

  const rpc = await post("/api/session.prompt", {
    type: "client-request",
    rpcId: "t-" + Date.now(),
    method: "session.prompt",
    payload: { sessionId, content: [{ type: "text", text: "WS 增量帧自检：回复 OK 即可" }] },
  });
  check(rpc.result && rpc.result.ok === true, "session.prompt 接受（accepted）");

  eventTimer = setTimeout(() => resolveEvent(false), 20000);
  asstTimer = setTimeout(() => resolveAsst(false), 45000);
  const got = await eventArrived;
  check(got, "mux: 收到 session/event 增量（agent 入队/消息事件）");
  // assistant 回复事件（模型输出）——确认流式链路完整
  const asst = await asstArrived;
  check(asst, "mux: 收到 assistant 回复事件（assistant/message|chunk|turn/end）");
  // 信封形状：检查首个标准会话事件（agent/inbox/spliced 是 agent 内部事件，无 seq/time）
  const env = frames.find((e) => e && e.type && typeof e.seq === "number" && (typeof e.time === "number" || typeof e.time === "string"));
  check(
    !!env && !!env.data && typeof env.type === "string",
    "mux: 标准事件形状（type + seq 数值 + time + data）",
  );
  if (env) console.log("[INFO] 标准事件样例:", env.type, "seq=" + env.seq);
  ws.close();
  console.log(`\n===== stage3 live: ${pass} PASS / ${fail} FAIL =====`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("[FAIL] unhandled: " + e.message);
  process.exit(1);
});