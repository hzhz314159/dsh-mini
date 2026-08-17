new Promise(async (res) => {
  try {
    var r = await (await fetch("/api/workspace.list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "wl", method: "workspace.list", payload: {} }),
    })).json();
    var sl = await (await fetch("/api/session.list", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "sl", method: "session.list", payload: { offset: 0, limit: 3 } }),
    })).json();
    var wsItems = (r.result && r.result.value && r.result.value.items) || [];
    var sessItems = (sl.result && sl.result.value && sl.result.value.items) || [];
    res(JSON.stringify({
      workspaces: wsItems.map((w) => ({ id: w.workspaceId, title: w.title, path: w.path, sessionCount: (w.sessionIds || []).length })),
      sessions: sessItems.map((s) => ({ sid: s.sessionId, cwd: s.cwd, title: s.projections && s.projections.values && s.projections.values.title && s.projections.values.title.title, updatedAt: s.updatedAt })),
    }));
  } catch (e) { res("ERR " + e.message); }
});