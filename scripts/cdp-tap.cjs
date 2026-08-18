// cdp-tap.cjs — 通过 CDP Input 协议发送真实点击（touchStart+touchEnd + mouse 序列），验证移动端可点性
// 用法: node cdp-tap.cjs <x> <y>
(async () => {
  const x = parseInt(process.argv[2], 10);
  const y = parseInt(process.argv[3], 10);
  if (Number.isNaN(x) || Number.isNaN(y)) {
    console.error("usage: node cdp-tap.cjs <x> <y>");
    process.exit(1);
  }
  let list;
  try {
    list = await (await fetch("http://127.0.0.1:9222/json")).json();
  } catch (e) {
    console.error("CDP /json 失败（先 adb forward）: " + e.message);
    process.exit(1);
  }
  const page = list.find((p) => p.type === "page");
  if (!page) { console.error("未找到 page"); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  const send = (method, params) =>
    new Promise((resolve) => {
      const mid = ++id;
      pending.set(mid, resolve);
      ws.send(JSON.stringify({ id: mid, method, params: params || {} }));
    });

  const btn = { x, y };
  // 触摸序列
  const tp = [{ x, y, radiusX: 4, radiusY: 4, force: 1, id: 1 }];
  await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: tp });
  await new Promise((r) => setTimeout(r, 100));
  await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await new Promise((r) => setTimeout(r, 100));
  // 鼠标序列（部分 React 组件只认 mouse 事件）
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 80));
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 500));
  console.log("TAP", x, y, "done");
  ws.close();
  process.exit(0);
})().catch((e) => {
  console.error("ERR", e.message);
  process.exit(1);
});