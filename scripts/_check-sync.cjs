// 本机直接调 dsh-mini 网关 RPC 检查 workspace/session 同步
const TOKEN = "a776441024674c18988959905c057fa9";
const BASE = "http://127.0.0.1:46322";
async function rpc(method, payload) {
  const r = await fetch(BASE + "/api/" + method + "?token=" + TOKEN, {
    method: "POST", headers: { "Content-Type": "application/json", "x-dsh-mini-gateway": "1" },
    body: JSON.stringify({ type: "client-request", rpcId: Math.random().toString(36).slice(2), method, payload }),
  });
  return (await r.json()).result;
}
(async () => {
  const ws = await rpc("workspace.list", {});
  const wsItems = (ws.value && ws.value.items) || [];
  console.log("=== Workspaces ===");
  wsItems.forEach((w) => console.log(`  id=${w.workspaceId} title="${w.title}" path="${w.path}" sessions=${(w.sessionIds||[]).length}`));

  const sl = await rpc("session.list", { offset: 0, limit: 5 });
  const items = (sl.value && sl.value.items) || [];
  console.log("=== Sessions (top 5) ===");
  items.forEach((s) => {
    const title = s.projections && s.projections.values && s.projections.values.title && s.projections.values.title.title;
    console.log(`  sid=${s.sessionId.slice(0,20)} cwd="${s.cwd}" title="${title}" updatedAt=${s.updatedAt}`);
  });

  // 检查新建会话是否触发 session/created（电脑端是否能看到）
  console.log("\n=== Test: create session ===");
  const created = await rpc("session.create", { cwd: "E:\\DSH Zone" });
  console.log("  result:", JSON.stringify(created));
  if (created.ok) {
    const newSid = created.value.sessionId;
    console.log("  new session:", newSid);
    // 等 2 秒看 session.list 是否包含新会话
    await new Promise((r) => setTimeout(r, 2000));
    const sl2 = await rpc("session.list", { offset: 0, limit: 3 });
    const items2 = (sl2.value && sl2.value.items) || [];
    const found = items2.find((s) => s.sessionId === newSid);
    console.log("  found in list:", !!found, found ? `cwd="${found.cwd}"` : "");
  }
  process.exit(0);
})().catch((e) => { console.error(e.message); process.exit(1); });