// trim-legacy.js — 清理 lib/index.js 中旧手机 UI 协议死代码（/threads /upload /workspaces /models /SSE /static 页）
// 按锚点字符串删除，UTF-8 安全；循序执行后 read 校验。
const fs = require("fs");
const path = "E:/DSH Zone/dsh-mini/lib/index.js";
let src = fs.readFileSync(path, "utf8");
const origLen = src.length;

function removeRange(startAnchor, endAnchor, label) {
  const si = src.indexOf(startAnchor);
  if (si < 0) throw new Error("START anchor not found: " + label);
  const ei = src.indexOf(endAnchor, si + startAnchor.length);
  if (ei < 0) throw new Error("END anchor not found: " + label + " (start found at " + si + ")");
  const removed = src.slice(si, ei);
  src = src.slice(0, si) + src.slice(ei);
  console.log(`[ok] ${label}: removed ${removed.length} chars`);
  return removed;
}

// 1) sessionsStore 链 + 模型选择 + 事件归一化 + live 镜像 + 会话驱动 + 列表 + segments + history + model catalog
removeRange(
  "// ===========================================================================\n// per-session model selection store",
  "\n// ===========================================================================\n// gateway status (M3)",
  "legacy model-selection→getModelCatalog block"
);

// 2) /models /upload /workspaces /threads 路由分支（dispatchApi 内）
removeRange(
  "    // GET /models\n    if (parts.length === 1 && parts[0] === \"models\" && method === \"GET\") {",
  "    return sendJson(res, 404, { error: \"not found: \" + pathname });",
  "dispatchApi legacy routes (models/upload/workspaces/threads)"
);

// 3) SSE 订阅注册表 + openStream + 静态页服务块（subscribers → dispatchStatic 之后）
removeRange(
  "// SSE subscriber registry: sessionId -> Set<ServerResponse>",
  "\n// ===========================================================================\n// plugin entry",
  "SSE + dispatchStatic block"
);

// 4) uploads 工具（IMAGE_EXTS/safeName/mimeOf/handleUpload/composeMessage）
removeRange(
  "// ===========================================================================\n// uploads (M2)",
  "\n// ===========================================================================\n// HTTP dispatch",
  "uploads tooling block"
);

// 5) apply() 中的旧 session/event fan-out（bufferPush + subscribers 投递 SSED）
removeRange(
  "  // 1) Global session-event listener -> fan out to phone SSE subscribers and",
  "  // 2) HTTP routes",
  "apply() legacy fan-out"
);

fs.writeFileSync(path, src, "utf8");
console.log(`\nDONE: ${origLen} -> ${src.length} chars (${origLen - src.length} removed)`);