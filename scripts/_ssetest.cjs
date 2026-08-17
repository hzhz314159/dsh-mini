const http = require("node:http");
const url = "http://127.0.0.1:46322/dsh-mini/api/threads/sse-test/stream?token=a776441024674c18988959905c057fa9";
const req = http.get(url, (res) => {
  console.log("SSE STATUS:", res.statusCode);
  let bytes = 0;
  let first = true;
  const timer = setInterval(() => {
    // keep-alive: if nothing arrived in 3s the stream is stuck
    if (first && bytes === 0) { console.log("SSE STUCK (0 bytes in 3s after connect)"); clearInterval(timer); req.destroy(); process.exit(2); }
  }, 3000);
  res.on("data", (c) => { bytes += c.length; if (first) { first = false; console.log("SSE first data chunk, bytes=" + c.length); } });
  setTimeout(() => {
    console.log("SSE received " + bytes + " bytes over 6s -> STREAM ALIVE");
    clearInterval(timer);
    req.destroy();
    process.exit(0);
  }, 6000);
});
req.on("error", (e) => { console.log("SSE ERROR:", e.message); process.exit(1); });
