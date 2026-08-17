new Promise(async (res) => {
  try {
    // 用已有会话发消息（避免创建）
    const list = await (await fetch("/api/session.list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "l1", method: "session.list", payload: { offset: 0, limit: 5 } }),
    })).json();
    const items = (list.result && list.result.value && list.result.value.items) || [];
    const sid = items[0] && items[0].sessionId;
    if (!sid) return res("NO_SESSION");
    // 发消息
    const pr = await fetch("/api/session.prompt", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "p1", method: "session.prompt", payload: { sessionId: sid, message: "测试消息：请回复'收到'两字" } }),
    });
    const pj = await pr.json();
    await new Promise((r) => setTimeout(r, 4000));
    res(JSON.stringify({
      sessionCount: items.length,
      firstSid: sid,
      firstTitle: items[0].projections && items[0].projections.values && items[0].projections.values.title && items[0].projections.values.title.title,
      promptOk: pj.result && pj.result.ok,
      promptErr: pj.result && pj.result.error && pj.result.error.code,
      afterBody: (document.body.innerText || "").slice(0, 200),
      taRO: document.querySelector("textarea") ? document.querySelector("textarea").readOnly : "no-ta",
    }));
  } catch (e) { res("ERR " + e.message); }
});