const http = require("node:http");
const TOKEN = "a776441024674c18988959905c057fa9";
const GW = "127.0.0.1:46322";
function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({ hostname: "127.0.0.1", port: 46322, path, method,
      headers: { "Authorization": "Bearer " + TOKEN, "Content-Type": "application/json" } }, (res) => {
      let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d }));
    });
    r.on("error", reject);
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}
(async () => {
  console.log("== 1. create thread ==");
  const c = await req("POST", "/dsh-mini/api/threads/new");
  console.log("status", c.status, c.body.slice(0, 200));
  const { id } = JSON.parse(c.body || "{}");
  console.log("new thread id:", id);
  if (!id) { console.log("FATAL: no id"); process.exit(1); }

  console.log("== 2. history ==");
  const h = await req("GET", "/dsh-mini/api/threads/" + encodeURIComponent(id) + "/history");
  console.log("status", h.status, "body head:", h.body.slice(0, 120));

  console.log("== 3. connect SSE ==");
  const sseReq = http.get({ hostname: "127.0.0.1", port: 46322,
    path: "/dsh-mini/api/threads/" + encodeURIComponent(id) + "/stream?token=" + TOKEN });
  let got = [];
  const evs = {};
  sseReq.on("response", (res) => {
    console.log("SSE status:", res.statusCode);
    let buf = "";
    res.on("data", (c) => {
      buf += c;
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const ev = buf.slice(0, i); buf = buf.slice(i + 2);
        const evName = (ev.match(/^event:\s*(.+)$/m) || [])[1] || "message";
        const data = (ev.match(/^data:\s*(.+)$/m) || [])[1] || "";
        evs[evName] = (evs[evName] || 0) + 1;
        got.push(evName + ":" + data.slice(0, 60));
      }
    });
  });
  await new Promise(r => setTimeout(r, 800));

  console.log("== 4. send message ==");
  const s = await req("POST", "/dsh-mini/api/threads/" + encodeURIComponent(id) + "/send", { text: "你好（同步测试）" });
  console.log("send status", s.status, s.body.slice(0, 100));

  await new Promise(r => setTimeout(r, 12000));
  console.log("== SSE events received ==");
  for (const ev of Object.keys(evs)) console.log("  " + ev + " x" + evs[ev]);
  console.log("sample:", got.slice(0, 8));
  sseReq.destroy();
  process.exit(0);
})().catch(e => { console.log("ERR", e); process.exit(1); });
