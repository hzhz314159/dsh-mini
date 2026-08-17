new Promise(async (res) => {
  try {
    // 获取当前活动会话
    var list = await (await fetch("/api/session.list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "l2", method: "session.list", payload: { offset: 0, limit: 3 } }),
    })).json();
    var items = (list.result && list.result.value && list.result.value.items) || [];
    var sid = items[0] && items[0].sessionId;
    if (!sid) return res("NO_SESSION");

    // 用官方格式发消息
    var pr = await fetch("/api/session.prompt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "client-request", rpcId: "p2", method: "session.prompt",
        payload: { sessionId: sid, mode: "queue", content: [{ type: "text", text: "你好，请只回复'收到'两个字" }], clientTimeZone: "Asia/Shanghai" },
      }),
    });
    var pj = await pr.json();

    // 等 15 秒看 GUI 是否实时更新
    var snapshots = [];
    for (var i = 0; i < 8; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      snapshots.push({
        t: (i + 1) * 2,
        body: (document.body.innerText || "").slice(0, 200),
        bubbleCount: document.querySelectorAll("[class*=bubble],[class*=assistant],[class*=thinking]").length,
      });
    }

    res(JSON.stringify({
      sid: sid,
      promptOk: pj.result && pj.result.ok,
      promptErr: pj.result && pj.result.error,
      snapshots: snapshots,
    }));
  } catch (e) { res("ERR " + e.message); }
});