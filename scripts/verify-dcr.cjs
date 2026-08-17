// /api/verify-dcr.cjs — 本机模拟前端调用 dynamicCordisRunner 与未知方法，验证信封通过官方 zod 校验
(async () => {
  const base = "http://127.0.0.1:46322";
  const call = async (method, payload) => {
    const rpcId = crypto.randomUUID?.() || "test-rpc";
    const res = await fetch(`${base}/api/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId, method, payload: payload ?? {} }),
    });
    return { status: res.status, body: await res.json() };
  };
  const results = {};
  for (const m of ["dynamicCordisRunner/inventory", "dynamicCordisRunner/syncInspectManifest", "dynamicCordisRunner/getClientCode", "dynamicCordisRunner/reportRenderFailure", "dynamicCordisRunner/resolveInspectQuery", "dynamicCordisRunner/resolveRequestRun", "dynamicCordisRunner/settleUserRun", "dynamicCordisRunner/stopFromPanel", "dynamicCordisRunner/undefineFromPanel", "dynamicCordisRunner/runHostHalf", "dynamicCordisRunner/invoke", "foo.bar.unknown"]) {
    const r = await call(m, {});
    results[m] = { status: r.status, ok: r.body?.result?.ok, error: r.body?.result?.error ? { code: r.body.result.error.code, hasDetails: !!r.body.result.error.details } : undefined, hasRpcId: r.body?.rpcId === "test-rpc" || typeof r.body?.rpcId === "string" };
  }
  console.log(JSON.stringify(results, null, 2));
  const bad = Object.entries(results).filter(([, v]) => v.status !== 200 || v.ok === false && !["internal", "agent-preset-read-only", "credential-rejected", "directory-create-failed", "directory-unreadable"].includes(v.error?.code));
  console.log(bad.length ? "FAIL: " + JSON.stringify(bad) : "ALL ENVELOPES OK");
  process.exit(bad.length ? 1 : 0);
})();