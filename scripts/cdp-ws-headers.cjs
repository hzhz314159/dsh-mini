// cdp-ws-headers.cjs — 抓前端 WebSocket 握手请求头与响应，直到成功或超时
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
  let done = false;
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Network.webSocketWillSendHandshakeRequest") {
      const r = msg.params.request;
      console.log("=== WILL SEND ===");
      console.log("url:", r.url);
      console.log("headers:", JSON.stringify(r.headers, null, 2));
    } else if (msg.method === "Network.webSocketHandshakeResponseReceived") {
      console.log("=== HANDSHAKE RESPONSE ===");
      console.log("status:", msg.params.response.status);
      console.log("headers:", JSON.stringify(msg.params.response.headers, null, 2));
    } else if (msg.method === "Network.webSocketClosed") {
      console.log("=== CLOSED ===", msg.params.timestamp);
    } else if (msg.method === "Network.webSocketFrameError") {
      console.log("=== FRAME ERROR ===", msg.params.errorMessage);
    } else if (msg.method === "Network.loadingFailed" && msg.params.type === "WebSocket") {
      console.log("=== WS LOAD FAIL ===", JSON.stringify(msg.params, null, 2));
    } else if (msg.method === "Network.webSocketCreated") {
      console.log("=== CREATED ===", msg.params.url);
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send("Network.enable", {});
  await send("Page.enable", {});
  // 用 runtime 触发一次重连：直接 evaluate 构造前端同样的 WS
  await send("Runtime.evaluate", {
    expression: "new WebSocket('ws://192.168.2.3:46322/api/events.mux')",
  });
  console.log("抓取 20s WS 事件。页面前端也在重连，会看到多条。");
  await new Promise((res) => setTimeout(res, 20000));
  ws.close();
  process.exit(0);
})();