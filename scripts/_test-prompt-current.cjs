new Promise(async (res) => {
  // 改进探针：加 onmessage 记录
  if (!window.__wsMsgLog) {
    window.__wsMsgLog = [];
    // 重新包装已存在的 WebSocket？不行——已创建的连接无法重新包装
    // 改为直接 hook WebSocket.prototype.addEventListener 拦截 message
  }

  // 当前会话从面包屑获取
  var crumb = document.querySelector("[class*=crumb]");
  var currentSid = crumb ? crumb.textContent.trim() : null;

  // 用 session.list 找到精确的 sid
  var list = await (await fetch("/api/session.list", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId: "l3", method: "session.list", payload: { offset: 0, limit: 5 } }),
  })).json();
  var items = (list.result && list.result.value && list.result.value.items) || [];

  // 找到 session-6d7d820f
  var target = items.find((i) => i.sessionId.includes("6d7d820f")) || items[0];
  if (!target) return res("NO_SESSION");

  // 发消息到当前会话
  var pr = await fetch("/api/session.prompt", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "client-request", rpcId: "p3", method: "session.prompt",
      payload: { sessionId: target.sessionId, mode: "queue", content: [{ type: "text", text: "测试消息：回复收到" }], clientTimeZone: "Asia/Shanghai" },
    }),
  });
  var pj = await pr.json();

  // 监听 body 变化 20 秒
  var bodyBefore = (document.body.innerText || "").slice(0, 200);
  var snapshots = [];
  for (var i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    var bodyAfter = (document.body.innerText || "").slice(0, 400);
    var changed = bodyAfter !== bodyBefore && bodyAfter.includes("收到");
    snapshots.push({ t: (i + 1) * 2, changed: changed, tail: bodyAfter.slice(-120) });
    if (changed) break;
  }

  res(JSON.stringify({
    targetSid: target.sessionId,
    promptOk: pj.result && pj.result.ok,
    promptErr: pj.result && pj.result.error,
    bodyBefore: bodyBefore,
    snapshots: snapshots,
  }));
});