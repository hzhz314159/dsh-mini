new Promise(async (res) => {
  try {
    const r = await fetch("/api/session.create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "client-request", rpcId: "c3", method: "session.create", payload: { cwd: "E:\\DSH Zone" } }),
    });
    const j = await r.json();
    const sid = j.result && j.result.value && j.result.value.sessionId;
    await new Promise((r) => setTimeout(r, 3000));
    res(JSON.stringify({
      ok: j.result && j.result.ok,
      sid: sid,
      err: j.result && j.result.error && j.result.error.code,
      afterCreate: {
        body: (document.body.innerText || "").slice(0, 200),
        taRO: document.querySelector("textarea") ? document.querySelector("textarea").readOnly : "no-textarea",
        taClass: document.querySelector("textarea") ? document.querySelector("textarea").className : null,
        frameStyle: document.querySelector("[data-details-collapsed]") ? document.querySelector("[data-details-collapsed]").style.cssText : null,
      },
    }));
  } catch (e) {
    res("ERR " + e.message);
  }
});