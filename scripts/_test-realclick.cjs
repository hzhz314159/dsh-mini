// 用 CDP Input.dispatchMouseEvent 模拟真实点击「新建会话」按钮
new Promise(async (res) => {
  // 先获取按钮位置
  const r1 = await (await fetch("http://127.0.0.1:9222/json")).json();
  const page = r1.find((p) => p.type === "page");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((r, e) => { ws.onopen = r; ws.onerror = () => e(new Error("ws")); });
  const send = (method, params) => new Promise((r) => { const mid = ++id; pending.set(mid, r); ws.send(JSON.stringify({ id: mid, method, params })); });

  // 获取按钮的 bounding box
  const box = await send("Runtime.evaluate", {
    expression: "(function(){var b=document.querySelector('.hHd-Xa_brand');if(!b)return JSON.stringify(null);var r=b.getBoundingClientRect();return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height})})()",
    returnByValue: true,
  });
  const coord = JSON.parse(box.result.result.value);
  if (!coord) { ws.close(); return res("NO_BUTTON"); }

  // 模拟 mousedown + mouseup
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: coord.x, y: coord.y, button: "left", clickCount: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: coord.x, y: coord.y, button: "left", clickCount: 1 });

  await new Promise((r) => setTimeout(r, 2000));

  // 检查结果
  const after = await send("Runtime.evaluate", {
    expression: "JSON.stringify({body:(document.body.innerText||'').slice(0,200),taRO:document.querySelector('textarea')?document.querySelector('textarea').readOnly:'no-ta',hasChat:!!document.querySelector('[class*=message],[class*=conversation],[class*=chat]')})",
    returnByValue: true,
  });
  ws.close();
  res(after.result.result.value);
});