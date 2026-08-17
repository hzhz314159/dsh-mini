new Promise(async (res) => {
  // 先查 WS 探针有无新帧
  var probeBefore = (window.__wsProbeLog || []).length;
  // 等 20 秒看 AI 回复
  var results = [];
  for (var i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    var body = (document.body.innerText || "").slice(0, 400);
    var hasNew = body.includes("收到") || body.includes("你好");
    results.push({ t: (i + 1) * 2, hasNew: hasNew, bodyTail: body.slice(-150) });
    if (hasNew) break;
  }
  res(JSON.stringify({
    probeBefore: probeBefore,
    probeAfter: (window.__wsProbeLog || []).length,
    probeLog: (window.__wsProbeLog || []).slice(-5),
    results: results,
    finalBody: (document.body.innerText || "").slice(-300),
  }));
});