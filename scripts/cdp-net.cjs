// cdp-net.cjs — 抓真机页面 reload 后 15s 内 HTTP 状态>=400 的资源 URL + WS 握手响应
(async () => {
  let page;
  try {
    const list = await (await fetch("http://127.0.0.1:9222/json")).json();
    page = list.find((p) => p.type === "page");
  } catch (e) {
    console.error("CDP /json 失败: " + e.message);
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  const bad = [];
  const wsInfo = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Network.responseReceived") {
      const r = msg.params.response;
      if (r.status >= 400) bad.push(r.status + " " + r.url);
    } else if (msg.method === "Network.webSocketCreated") {
      wsInfo.push("CREATED " + msg.params.url);
    } else if (msg.method === "Network.webSocketHandshakeResponseReceived") {
      wsInfo.push("HANDSHAKE " + msg.params.response.status + " " + msg.params.requestId);
    } else if (msg.method === "Network.webSocketClosed") {
      wsInfo.push("CLOSED " + msg.params.requestId);
    } else if (msg.method === "Network.loadingFailed") {
      if (msg.params.type === "WebSocket") wsInfo.push("WS-FAIL " + (msg.params.errorText || ""));
      else bad.push("LOAD-FAIL " + (msg.params.errorText || "") + " " + (msg.params.requestId || ""));
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error("ws"));
  });
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send("Network.enable", {});
  await send("Page.enable", {});
  await send("Page.reload", { ignoreCache: true });
  console.log("捕获 15s 网络事件…");
  await new Promise((res) => setTimeout(res, 15000));
  console.log("=== HTTP >=400 ===");
  for (const b of [...new Set(bad)]) console.log(b);
  if (!bad.length) console.log("(无)");
  console.log("=== WS ===");
  for (const w of wsInfo) console.log(w);
  if (!wsInfo.length) console.log("(无 WS 事件)");
  ws.close();
  process.exit(0);
})();