// 检查 mux WS 帧是否带 method 字段（热重载后）
const url = "ws://127.0.0.1:46322/api/events.mux?token=a776441024674c18988959905c057fa9";
const ws = new WebSocket(url);
let got = 0;
const timer = setTimeout(() => { console.log("TIMEOUT got=" + got); try { ws.close(); } catch {} process.exit(got > 0 ? 0 : 1); }, 8000);
ws.onopen = () => console.log("OPEN");
ws.onerror = (e) => console.log("ERR", e.message || e);
ws.onmessage = (e) => {
  got++;
  const obj = JSON.parse(e.data);
  if (typeof obj.method === "string") {
    console.log("FRAME_OK method=" + obj.method + " keys=" + Object.keys(obj).join(","));
    // 对首个（subscribed 基线）做完整校验
    if (obj.payload && obj.payload.type === "session/subscribed") {
      console.log("SUBSCRIBED sample: " + JSON.stringify({ sessionId: obj.payload.sessionId, lastSeq: obj.payload.lastSeq, frameType: obj.type, rpcId: typeof obj.rpcId }));
      clearTimeout(timer); try { ws.close(); } catch {} process.exit(0);
    }
  } else {
    console.log("FRAME_BAD keys=" + Object.keys(obj).join(",") + " raw=" + e.data.slice(0, 200));
  }
};