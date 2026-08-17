// CDP 截图：node scripts/cdp-shot.cjs [outfile.png]
const http = require("http");
const fs = require("fs");
const out = process.argv[2] || "E:/DSH Zone/dsh-mini/vm-shots/current.png";
const t0 = Date.now();
function rpc(ws, id, method, params) {
  return new Promise((res, rej) => {
    const onMsg = (e) => {
      const m = JSON.parse(e.data);
      if (m.id === id) { ws.removeEventListener("message", onMsg); m.error ? rej(new Error(m.error.message)) : res(m.result); }
    };
    ws.addEventListener("message", onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
(async () => {
  // 支持 --ws 参数连接指定 devtools ws 地址
  const argWs = process.argv.findIndex((a) => a === "--ws");
  const wsUrl = argWs > -1 ? process.argv[argWs + 1] : null;
  let target = null;
  if (wsUrl) {
    target = { webSocketDebuggerUrl: wsUrl };
  } else {
    const list = await (await fetch("http://127.0.0.1:9222/json")).json();
    target = list.find((t) => t.type === "page") || list[0];
    if (!target) throw new Error("no page target");
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = (e) => rej(new Error("ws fail")); });
  await rpc(ws, 1, "Page.enable", {});
  const shot = await rpc(ws, 2, "Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  console.log("SHOT " + out + " " + Math.round(shot.data.length / 1024) + "KB " + (Date.now() - t0) + "ms");
  ws.close();
  process.exit(0);
})().catch((e) => { console.error("FAIL " + e.message); process.exit(1); });