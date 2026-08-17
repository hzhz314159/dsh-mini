// cdp-watch.cjs — 不重载，监听 15s 现有页面的 console/异常/网络错误
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
  const logs = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.consoleAPICalled") {
      const args = (msg.params.args || []).map((a) => (a.value !== undefined ? JSON.stringify(a.value) : a.description || a.type)).join(" ");
      logs.push("[console." + msg.params.type + "] " + args.slice(0, 300));
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      logs.push("[EXCEPTION] " + (d.exception ? d.exception.description || JSON.stringify(d.exception) : d.text));
    } else if (msg.method === "Network.loadingFailed") {
      logs.push("[NET-FAIL] " + (msg.params.errorText || msg.params.blockedReason || "") + " " + (msg.params.url || ""));
    }
  };
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws")); });
  const send = (method, params) => new Promise((res) => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  await send("Runtime.enable", {});
  await send("Network.enable", {});
  console.log("监听 15s…");
  await new Promise((res) => setTimeout(res, 15000));
  const uniq = [...new Set(logs)];
  for (const l of uniq) console.log(l);
  if (!uniq.length) console.log("(无异常)");
  ws.close();
  process.exit(0);
})();