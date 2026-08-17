// cdp-console.cjs — 重载 WebView 页面并捕获 console/异常 25s，定位 boot 卡住根因
// 用法: node cdp-console.cjs [--reload]
(async () => {
  let list;
  try {
    list = await (await fetch("http://127.0.0.1:9222/json")).json();
  } catch (e) {
    console.error("CDP /json 失败: " + e.message);
    process.exit(1);
  }
  const page = list.find((p) => p.type === "page");
  if (!page) {
    console.error("未找到 page");
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
      logs.push("[console." + msg.params.type + "] " + args.slice(0, 400));
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      logs.push("[EXCEPTION] " + (d.exception ? d.exception.description || JSON.stringify(d.exception) : d.text) + " @" + (d.url || "") + ":" + d.lineNumber);
    } else if (msg.method === "Log.entryAdded") {
      logs.push("[log." + msg.params.entry.level + "] " + String(msg.params.entry.text).slice(0, 400));
    } else if (msg.method === "Network.loadingFailed") {
      logs.push("[NET-FAIL] " + msg.params.type + " " + (msg.params.blockedReason || msg.params.errorText || "") + " " + (msg.params.requestId || ""));
    }
  };
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = (e) => rej(new Error("ws error"));
  });
  const send = (method, params) =>
    new Promise((res) => {
      const mid = ++id;
      pending.set(mid, res);
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await send("Runtime.enable", {});
  await send("Log.enable", {});
  await send("Network.enable", {});
  if (process.argv.includes("--reload")) {
    await send("Page.enable", {});
    await send("Page.reload", { ignoreCache: true });
  }
  console.log("捕获 25s console/异常…");
  await new Promise((res) => setTimeout(res, 25000));
  const uniq = [...new Set(logs)];
  for (const l of uniq) console.log(l);
  if (!uniq.length) console.log("(无 console/异常输出)");
  // 最后看一眼页面状态
  const r = await send("Runtime.evaluate", {
    expression: "(document.body.innerText||'').slice(0,200)",
    returnByValue: true,
  });
  console.log("BODY:", JSON.stringify(r.result && r.result.result && r.result.result.value));
  ws.close();
  process.exit(0);
})();