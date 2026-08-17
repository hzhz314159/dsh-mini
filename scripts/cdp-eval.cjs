// cdp-eval.cjs — 对真机 WebView（经 adb forward tcp:9222）执行 JS 并打印结果
// 用法: node cdp-eval.cjs "<js-expr>" [--timeout-ms N]
(async () => {
  const expr = process.argv[2];
  const timeoutArg = process.argv.findIndex((a) => a === "--timeout-ms");
  const timeoutMs = timeoutArg > 0 ? parseInt(process.argv[timeoutArg + 1], 10) : 15000;
  if (!expr) {
    console.error("usage: node cdp-eval.cjs <js-expr> [--timeout-ms N]");
    process.exit(1);
  }
  let list;
  try {
    list = await (await fetch("http://127.0.0.1:9222/json")).json();
  } catch (e) {
    console.error("CDP /json 失败（先 adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>）: " + e.message);
    process.exit(1);
  }
  const page = list.find((p) => p.type === "page");
  if (!page) {
    console.error("未找到 page: " + JSON.stringify(list));
    process.exit(1);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
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
  const timer = setTimeout(() => {
    console.error("TIMEOUT after " + timeoutMs + "ms");
    process.exit(2);
  }, timeoutMs);
  const r = await send("Runtime.evaluate", {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  clearTimeout(timer);
  if (r.result && r.result.exceptionDetails) {
    console.error("JS EXCEPTION: " + JSON.stringify(r.result.exceptionDetails, null, 2));
    process.exit(3);
  }
  const v = r.result && r.result.result;
  console.log(JSON.stringify(v && v.value !== undefined ? v.value : v, null, 2));
  ws.close();
  process.exit(0);
})();
