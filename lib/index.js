// @deepseek-ai/dsh-mini
// DSH Mini — phone bridge for DeepSeek Harness Desktop (Codex-Mini style).
//
// Runs INSIDE the DSH webServer as a Cordis plugin. A phone browser / app talks
// to this plugin over HTTP; the plugin drives real DSH agent sessions and
// streams their live events back. Every session is a real DSH session on the
// computer — the phone is just one remote participant, so the desktop and the
// phone are BIDIRECTIONALLY controllable and see the same event stream.
//
// v1.2.0 — M2 + M3:
//   * M1 loop (threads/new/send/stream/stop) kept, with compat fixes for
//     runtime 0.1.0-rc.6:
//       - titles/models come from log folds (session/title + request/header)
//         because persistence headers carry no title/model/updatedAt;
//       - session logs are zstd-framed JSONL by default — incremental frame
//         decode with mtime/size cache (dsh-side-session pattern);
//       - live history merges the rehydration-frozen session.events with our
//         live session/event mirror, deduped by seq;
//       - turn/end reasons pass through the full kind set
//         (completed/blocked/aborted/interrupted/error/max-tokens).
//   * M2: raw-body uploads (/upload) with attachment path injection on send
//     (images are handed to the agent as absolute paths + a view_image hint);
//     GET /models catalog from ctx.llm; per-session model switching via
//     installModelSelection with a caller-held mutable selection object,
//     persisted to ~/.dsh/dsh-mini/sessions.json; POST /threads/:id/attach.
//   * M3: balance ring data (host cache fed by the desktop client half via
//     POST /balance/report — dsh-balance has no host API of its own); LAN
//     gateway settings (GET /gateway, POST /gateway/config, POST
//     /gateway/token/reset) persisted to ~/.dsh/dsh-mini/config.json.
//
// Every registration is wrapped in ctx.effect and routes self-heal on
// re-registration conflicts, so the super-injector hot reload stays clean.

import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { join, normalize, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handleGuiApi, RpcError } from "./gui-api.js";
import { attachGuiWs } from "./gui-ws.js";

const name = "@deepseek-ai/dsh-mini";
const inject = [
  "webServer",
  "agents",
  "sessions",
  "agentDefaultModel",
  "sessionPersistence",
  "sessionTitle",
  "llm",
];

const PLUGIN_VERSION = (() => {
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

const API_PREFIX = "/dsh-mini/api";
const APP_PREFIX = "/dsh-mini";
const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));
const GUI_DIR = resolve(fileURLToPath(new URL("../gui", import.meta.url)));
const MINI_HOME = join(homedir(), ".dsh", "dsh-mini");

// GUI 静态服务 —— 官方 DSH 前端快照（阶段0 采集的 gui/dist + gui/bundles）
const GUI_DIST = join(GUI_DIR, "dist");
const GUI_BUNDLES = join(GUI_DIR, "bundles");
const GUI_MANIFEST = join(GUI_DIR, "manifest.json");
let bootManifestCache = null; // { at, manifest }
function loadBootManifest() {
  const now = Date.now();
  if (bootManifestCache && now - bootManifestCache.at < 5000) return bootManifestCache.manifest;
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(GUI_MANIFEST, "utf8"));
  } catch {
    /* not collected yet */
  }
  bootManifestCache = { at: now, manifest };
  return manifest;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};
function contentTypeFor(p) {
  return MIME[extname(p).toLowerCase()] || "application/octet-stream";
}

// GUI 会话：?token= 校验通过后发 HttpOnly cookie（30 天），后续子资源自动携带。
// 无状态签名会话：sid = "<expiryHex>.<hmacHex>"，hmac = HMAC-SHA256(当前token, expiry)。
// 优点：不占内存、热重载/重启后 cookie 依然有效；token 轮换（重置）后旧 cookie 因
// 签名密钥变化自动失效 —— 与「token 即钥匙」的安全模型一致。
const GUI_SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
function signGuiSid(exp) {
  return createHmac("sha256", effectiveToken() || "no-token")
    .update(String(exp))
    .digest("hex");
}
function issueGuiSession(res, url) {
  const exp = Date.now() + GUI_SESSION_TTL_MS;
  const sid = exp.toString(16) + "." + signGuiSid(exp);
  res.setHeader(
    "Set-Cookie",
    `dsh_mini_sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(GUI_SESSION_TTL_MS / 1000)}`,
  );
  const clean = url.search ? `${url.pathname}${url.search}` : url.pathname;
  res.writeHead(302, { Location: clean.replace(/[?&]token=[^&]*/g, "").replace(/[?&]$/, "") || "/" });
  res.end();
}
function hasGuiSession(req) {
  const m = /(?:^|;\s*)dsh_mini_sid=([0-9a-f]+\.[0-9a-f]+)/.exec(req.headers.cookie || "");
  if (!m) return false;
  const [expHex, sig] = m[1].split(".");
  const exp = parseInt(expHex, 16);
  if (!Number.isFinite(exp) || Date.now() > exp) return false;
  const expect = signGuiSid(exp);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expect, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function authGuiRequest(req, res, url) {
  // 本机直连（桌面浏览器/回环）免 token；LAN 经网关进来必须有会话或 token
  if (isLoopback(req) && req.headers["x-dsh-mini-gateway"] !== "1") return true;
  if (hasGuiSession(req)) return true;
  const want = effectiveToken();
  if (want && url.searchParams.get("token") === want) {
    issueGuiSession(res, url);
    return false; // 已发 302
  }
  sendText(
    res,
    403,
    "<!doctype html><html lang=\"zh-CN\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<style>body{font:16px/1.6 system-ui,sans-serif;background:#151517;color:#dfe1e5;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}" +
      "div{max-width:420px;padding:24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{color:#9a9da5;margin:0 0 16px}code{background:#26262a;padding:2px 8px;border-radius:6px;color:#8fb7ff}</style>" +
      "<div><h1>需要连接令牌</h1><p>请使用 DSH-Mobile 应用扫码连接，或在地址后附加</p><code>?token=你的令牌</code></div></body></html>",
    "text/html; charset=utf-8",
  );
  return false;
}
// WS upgrade 鉴权（无 res，升级阶段无法 302/写 403 页）；token 通过即放行
function authGuiWs(req, url) {
  if (isLoopback(req) && req.headers["x-dsh-mini-gateway"] !== "1") return true;
  if (hasGuiSession(req)) return true;
  const want = effectiveToken();
  if (want && url.searchParams.get("token") === want) return true;
  return false;
}
// 静态文件安全解析：拒绝 .. 穿越
function safeResolve(root, urlPath) {
  const target = resolve(root, "." + urlPath);
  if (target !== root && !target.startsWith(root + "\\") && !target.startsWith(root + "/")) return null;
  return target;
}

const MAX_BODY_BYTES = Number(process.env.DSH_MINI_MAX_BODY || 8 * 1024 * 1024);
const DEFAULT_MAX_UPLOAD_MB = 20;
const MAX_UPLOAD_MB_CAP = 100;
const DEFAULT_GATEWAY_PORT = 46322;
const MIN_GATEWAY_PORT = 1024;
const MAX_GATEWAY_PORT = 65535;
const FILE_MAP_TTL_MS = 60_000;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

// ===========================================================================
// small utilities
// ===========================================================================
function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function isLoopback(req) {
  const h = req.socket?.remoteAddress || "";
  return h === "127.0.0.1" || h === "::1" || h === "::ffff:127.0.0.1" || h === "fe80::1";
}

// 真正来自本机的请求（非网关代理转发）。loopback-only 端点必须用它，
// 否则经网关进来的手机请求 remoteAddress 是回环，会绕过限制。
function isLocalDirect(req) {
  return req.headers["x-dsh-mini-gateway"] !== "1" && isLoopback(req);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

// ===========================================================================
// token + config (~/.dsh/dsh-mini/)
// ===========================================================================
function tokenFile() {
  return join(MINI_HOME, "token.txt");
}

function effectiveToken() {
  if (process.env.DSH_MINI_TOKEN) return process.env.DSH_MINI_TOKEN;
  const f = tokenFile();
  if (existsSync(f)) {
    try {
      return readFileSync(f, "utf8").trim();
    } catch {
      /* ignore */
    }
  }
  return "";
}

function ensureToken() {
  const t = effectiveToken();
  if (t) return t;
  mkdirSync(MINI_HOME, { recursive: true });
  const fresh = randomUUID().replace(/-/g, "");
  writeFileSync(tokenFile(), fresh, "utf8");
  return fresh;
}

function resetToken() {
  mkdirSync(MINI_HOME, { recursive: true });
  const fresh = randomUUID().replace(/-/g, "");
  writeFileSync(tokenFile(), fresh, "utf8");
  return fresh;
}

// 鉴权：回环地址免 token；非回环需 Bearer / x-dsh-mini-token / ?token= 匹配。
// （EventSource 不能设请求头，LAN 手机走 ?token= 传参。）
// 经 LAN 网关代理进来的请求（x-dsh-mini-gateway: 1）remoteAddress 恒为回环，
// 必须强制按 LAN 规则校验 token，否则手机会被误判为回环而免鉴权。
function assertAuth(req, res, url) {
  const viaGateway = req.headers["x-dsh-mini-gateway"] === "1";
  if (isLoopback(req) && !viaGateway) return true;
  const want = effectiveToken();
  if (!want) {
    sendJson(res, 401, { error: "bridge token not configured; set DSH_MINI_TOKEN or connect via loopback" });
    return false;
  }
  const auth = req.headers["authorization"] || "";
  let provided = auth.startsWith("Bearer ") ? auth.slice(7).trim() : req.headers["x-dsh-mini-token"] || "";
  if (!provided && url) provided = url.searchParams.get("token") || "";
  if (provided !== want) {
    sendJson(res, 403, { error: "invalid token" });
    return false;
  }
  return true;
}

function configFile() {
  return join(MINI_HOME, "config.json");
}

let configCache = null; // { at, cfg }

function loadConfig() {
  const now = Date.now();
  if (configCache && now - configCache.at < 5000) return configCache.cfg;
  let cfg = {};
  try {
    cfg = JSON.parse(readFileSync(configFile(), "utf8"));
  } catch {
    /* defaults */
  }
  const out = {
    lanEnabled: cfg.lanEnabled !== false,
    maxUploadMb: Number.isFinite(Number(cfg.maxUploadMb))
      ? Math.min(Math.max(Number(cfg.maxUploadMb), 1), MAX_UPLOAD_MB_CAP)
      : DEFAULT_MAX_UPLOAD_MB,
    gatewayPort: Number.isFinite(Number(cfg.gatewayPort))
      ? Math.min(Math.max(Math.round(Number(cfg.gatewayPort)), MIN_GATEWAY_PORT), MAX_GATEWAY_PORT)
      : DEFAULT_GATEWAY_PORT,
  };
  configCache = { at: now, cfg: out };
  return out;
}

function saveConfig(patch) {
  const cfg = loadConfig();
  const next = {
    lanEnabled: typeof patch.lanEnabled === "boolean" ? patch.lanEnabled : cfg.lanEnabled,
    maxUploadMb: Number.isFinite(Number(patch.maxUploadMb))
      ? Math.min(Math.max(Number(patch.maxUploadMb), 1), MAX_UPLOAD_MB_CAP)
      : cfg.maxUploadMb,
    gatewayPort: Number.isFinite(Number(patch.gatewayPort))
      ? Math.min(Math.max(Math.round(Number(patch.gatewayPort)), MIN_GATEWAY_PORT), MAX_GATEWAY_PORT)
      : cfg.gatewayPort,
  };
  mkdirSync(MINI_HOME, { recursive: true });
  writeFileSync(configFile(), JSON.stringify(next, null, 2), "utf8");
  configCache = { at: Date.now(), cfg: next };
  return next;
}

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, "body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readBodyBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(httpError(413, "body too large (limit " + Math.round(limit / 1048576) + "MB)"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}


// ===========================================================================
// gateway status (M3)
// ===========================================================================
function lanAddresses() {
  const out = [];
  let ifaces;
  try {
    ifaces = networkInterfaces();
  } catch {
    return out;
  }
  for (const key of Object.keys(ifaces)) {
    const lk = key.toLowerCase();
    if (/(virtual|vmware|vethernet|wsl|loopback|docker|vbox|hyper-v|bluetooth|tailscale)/.test(lk)) continue;
    for (const ni of ifaces[key] || []) {
      if (ni.family === "IPv4" && !ni.internal && ni.address) out.push(ni.address);
    }
  }
  // fallback: any non-internal IPv4 (virtual adapters included)
  if (out.length === 0) {
    for (const key of Object.keys(ifaces)) {
      for (const ni of ifaces[key] || []) {
        if (ni.family === "IPv4" && !ni.internal && ni.address) out.push(ni.address);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// LAN gateway listener (M3): the DSH webServer may bind 127.0.0.1 only, which
// phones can never reach. The gateway is our OWN http server on 0.0.0.0 that
// reverse-proxies ONLY /dsh-mini paths to the loopback webServer, stamping
// requests with x-dsh-mini-gateway: 1 so the auth layer still enforces the
// bridge token. SSE streams pipe through unchanged (long-lived connections).
// ---------------------------------------------------------------------------
let gwServer = null;
let gwListening = false;
let gwListenError = "";
// upstream target — refreshed whenever the gateway (re)starts
let gwUpstreamPort = 0;
let gwUpstreamHost = "127.0.0.1";

function stopGateway() {
  const s = gwServer;
  gwServer = null;
  gwListening = false;
  gwListenError = "";
  if (s) {
    try {
      s.close();
    } catch {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------------------
// GUI app server — serves the official DSH frontend snapshot on the gateway:
//   GET /                           -> index.html with injected __DSH_BOOT__
//   GET /assets/*                   -> gui/dist/assets/*
//   GET /plugins/<id>/client.js     -> gui/bundles/<id>/client.js
//   GET /manifest.webmanifest|/favicon.svg -> gui/dist root files
// Auth: loopback direct = free; LAN needs ?token= (exchanges for a 30-day
// HttpOnly cookie) or a valid cookie. /dsh-mini/* stays proxied to the main
// port for legacy phone-app compatibility.
// ---------------------------------------------------------------------------
let guiIndexCache = null; // { rev, html }

function buildGuiledIndex() {
  const manifest = loadBootManifest();
  const rev = (manifest && manifest.rev) || "none";
  if (guiIndexCache && guiIndexCache.rev === rev) return guiIndexCache.html;
  let html;
  try {
    html = readFileSync(join(GUI_DIST, "index.html"), "utf8");
  } catch {
    html = "<!doctype html><meta charset=\"utf-8\"><title>DSH-Mobile</title><h1>GUI 资产未采集</h1>";
  }
  const boot = JSON.stringify({ rev, entries: manifest ? manifest.entries : [] });
  // ES2022+ polyfills for older Android WebView kernels (e.g. Huawei Android 10
  // lacks Object.hasOwn, which cordis runtime calls during boot).
  const polyfill =
    "<script>window.__dshPolyfill=1;(function(){" +
    "if(!Object.hasOwn){Object.defineProperty(Object,'hasOwn',{value:function(o,p){return Object.prototype.hasOwnProperty.call(o,p)}})}" +
    "if(!Array.prototype.at){Object.defineProperty(Array.prototype,'at',{value:function(n){n=Math.trunc(n)||0;if(n<0)n+=this.length;return this[n]}})}" +
    "if(!Array.prototype.findLast){Object.defineProperty(Array.prototype,'findLast',{value:function(f){for(var i=this.length-1;i>=0;i--){if(f(this[i],i,this))return this[i]}}})}" +
    "if(!Array.prototype.findLastIndex){Object.defineProperty(Array.prototype,'findLastIndex',{value:function(f){for(var i=this.length-1;i>=0;i--){if(f(this[i],i,this))return i}return -1}})}" +
    "if(!String.prototype.replaceAll){Object.defineProperty(String.prototype,'replaceAll',{value:function(s,r){var e=s instanceof RegExp&&!s.global?new RegExp(s.source,'g'+(s.flags||'')):s;return this.split(e).join(r)}})}" +
    "if(typeof structuredClone!=='function'){window.structuredClone=function(v){return JSON.parse(JSON.stringify(v))}}" +
    "if(window.crypto){if(typeof crypto.getRandomValues!=='function'){crypto.getRandomValues=function(a){for(var i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256);return a}}if(typeof crypto.randomUUID!=='function'){crypto.randomUUID=function(){var b=crypto.getRandomValues(new Uint8Array(16));b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h='';for(var i=0;i<16;i++){h+=(i===4||i===6||i===8||i===10)?'-':'';h+=(b[i]<16?'0':'')+b[i].toString(16)}return h}}}" +
    "if(typeof AbortSignal!=='undefined'&&typeof AbortSignal.timeout!=='function'){AbortSignal.timeout=function(ms){var c=new AbortController();var t=setTimeout(function(){try{c.abort(new DOMException('The operation timed out','TimeoutError'))}catch(e){c.abort(new Error('Timeout'))}},ms);try{c.signal.addEventListener('abort',function(){clearTimeout(t)})}catch(e){}return c.signal}}" +
    "if(typeof AbortController!=='undefined'){var origAbort=AbortController.prototype.abort;AbortController.prototype.abort=function(reason){if(arguments.length===0){return origAbort.call(this,new Error('Aborted'))}return origAbort.call(this,reason)}}" +
    "window.__wsProbeLog=[];var NW=window.WebSocket;window.WebSocket=function(url,protocols){var s=protocols?new NW(url,protocols):new NW(url);var t0=Date.now();function rec(ev,x){try{window.__wsProbeLog.push(ev+' '+url+' '+(Date.now()-t0)+'ms'+(x?' '+x:''));window.__wsProbeLog=window.__wsProbeLog.slice(-120)}catch(e){}}try{s.addEventListener('open',function(){rec('OPEN')});s.addEventListener('error',function(){rec('ERR')});s.addEventListener('close',function(e){rec('CLOSE'+e.code,(e.reason||''))})}catch(e){rec('HOOKFAIL',String(e))}return s;};try{window.WebSocket.prototype=NW.prototype}catch(e){}" +
    "})();</script>";
  // ── 手机端 UI 改造：完整补丁（CSS + JS）──
  // 关键：grid 列宽 0px 1fr 0px（不是 display:none——display:none 会让 grid 子元素前移到 0px 列）
  const mobileCss =
    "*{-webkit-tap-highlight-color:transparent!important}" + // #12 黄框
    ".pXSMma_previewBadge{display:none!important}" + // #1 预览版标志
    ".nL4_yW_sessionLogButton{display:none!important}" + // 删除 session log
    // #3+#5: grid 列宽改 0 1fr 0（sidebarCol 仍在 grid 中但 0 宽不可见；detailsCol 同理）
    ".pI_x6G_frame{grid-template-columns:0px minmax(0,1fr) 0px!important}" +
    ".pI_x6G_centerCol{grid-column:2!important}" + // 锁定 center 在第二列，sidebarCol fixed 脱离 grid 时不变
    ".pI_x6G_sidebarCol{overflow:hidden!important;grid-column:1}" + // 0 宽时内容不溢出
    ".pI_x6G_detailsCol{overflow:hidden!important;grid-column:3}" + // #5 右栏 0 宽不显示
    // #4: 侧栏展开时 fixed overlay 不影响主页 grid
    "body.dsh-sb-open .pI_x6G_sidebarCol{position:fixed!important;top:0;left:0;bottom:0;width:min(320px,85vw)!important;max-width:85vw;z-index:9000;overflow:auto!important;box-shadow:4px 0 24px rgba(0,0,0,.5)!important}" +
    ".dsh-scrim{display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:8999;background:rgba(0,0,0,.5)}" +
    "body.dsh-sb-open .dsh-scrim{display:block!important}" +
    // #2: 隐藏设置页插件/Agent预设 tab
    ".VOzbGW_navCell:nth-child(3),.VOzbGW_navCell:nth-child(4){display:none!important}" +
    // #7: 设置页单列向下展开
    ".VOzbGW_panel{flex-direction:column!important}" +
    ".VOzbGW_nav{flex-direction:row!important;flex-wrap:nowrap;overflow-x:auto;flex-shrink:0}" +
    ".VOzbGW_navCell{flex:0 0 auto;white-space:nowrap}" +
    ".VOzbGW_content{flex:1 1 auto;overflow-y:auto;width:100%!important;max-width:none!important}" +
    // #9: 输入框可交互（grid 修复后应自动恢复，额外保障）
    ".uV2eYG_input{user-select:text!important;-webkit-user-select:text!important;pointer-events:auto!important}" +
    ".uV2eYG_card{pointer-events:auto!important}" +
    // N1+N8: 页面固定 + 刘海屏顶部留空（body 固定不滚动，frame 高度扣除 safe-top）
    "body{position:fixed!important;top:0;left:0;right:0;bottom:0;overflow:hidden!important;padding-top:var(--dsh-safe-top,0px)!important;margin:0!important}" +
    ".pI_x6G_frame{height:calc(100vh - var(--dsh-safe-top,0px))!important;max-height:calc(100vh - var(--dsh-safe-top,0px))!important}" +
    // N11: 删除右上相机/左上鲸鱼，改最左侧边框中部箭头按钮展开侧栏
    "#dsh-sb-toggle,#dsh-scan-entry{display:none!important}" +
    "#dsh-sb-arrow{position:fixed;top:50%;left:0;transform:translateY(-50%);z-index:9500;width:32px;height:56px;border-radius:0 12px 12px 0;background:rgba(35,35,36,.92);border:none;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:2px 0 8px rgba(0,0,0,.3)}" +
    "#dsh-sb-arrow svg{width:14px;height:14px;display:block}" +
    "#dsh-sb-arrow:active{transform:translateY(-50%) scale(.95)}" +
    "body.dsh-sb-open #dsh-sb-arrow{display:none}" + // 侧栏展开时箭头隐藏（scrim 关闭）
    // N8: composer 模型选择只保留展开按钮（隐藏文字，留 chevron 图标）
    ".uV2eYG_row ._7KE1Ra_triggerLabel,.uV2eYG_row ._7KE1Ra_triggerEffort{display:none!important}" +
    ".uV2eYG_row ._7KE1Ra_trigger{width:30px!important;min-width:30px!important;height:30px!important;padding:0!important;justify-content:center!important;border-radius:8px!important}" +
    ".uV2eYG_row ._7KE1Ra_trigger ._7KE1Ra_chevron{width:16px!important;height:16px!important;margin-left:10px!important}" +
    // N3: 键盘展开时 composer 跟随上滚（transform by --keyboard-shift）
    "body.dsh-kb-open .uV2eYG_card{transform:translate3d(0,calc(-1*var(--keyboard-shift,0px)),0)!important;transition:transform .15s ease}" +
    "body.dsh-kb-open .Md3f7G_scroll{transform:translate3d(0,calc(-1*var(--keyboard-shift,0px)),0)!important;transition:transform .15s ease}" +
    // N6: 设置面板扫码连接按钮（注入到 header；右上角常驻按钮已删除）
    // 用户需求: 删除主页文本框左下角的命令按钮（toggleCommandMenu）
    ".uV2eYG_add{display:none!important}" +
    "";
  const mobileJsTpl =
    "(function(){" +
    "function safeTop(){try{if(window.DshMiniBridge&&DshMiniBridge.getSafeTop){var px=DshMiniBridge.getSafeTop();if(px>0)return Math.round(px/(window.devicePixelRatio||1))}}catch(e){}return 0}" +
    "function safeBottom(){try{if(window.DshMiniBridge&&DshMiniBridge.getSafeBottom){var px=DshMiniBridge.getSafeBottom();if(px>0)return Math.round(px/(window.devicePixelRatio||1))}}catch(e){}return 0}" +
    "function applySafe(){var t=safeTop();if(t>0){document.documentElement.style.setProperty('--dsh-safe-top',t+'px')}}" +
    "function init(){" +
    "if(!document.body)return setTimeout(init,200);" +
    "applySafe();" +
    // N1 改版: 最左侧边框中部箭头按钮展开侧边栏（替代左上鲸鱼）
    "var btn=document.createElement('button');" +
    "btn.id='dsh-sb-arrow';" +
    "btn.setAttribute('aria-label','展开侧边栏');" +
    "btn.innerHTML='<svg viewBox=\"0 0 24 24\" fill=\"none\"><path d=\"M9 5l7 7-7 7\" stroke=\"#8a8f98\" stroke-width=\"2.4\" stroke-linecap=\"round\" stroke-linejoin=\"round\"/></svg>';" +
    "function officialCollapsed(){var r=document.querySelector('.hHd-Xa_root');return r&&r.className.indexOf('collapsed')>=0}" +
    "function officialToggle(){var t=document.querySelector('.hHd-Xa_toggle');if(t)t.click()}" +
    "function closeSettingsPanel(){var m=document.querySelector('.VOzbGW_mask');if(m)m.click()}" +
    "function openSb(){closeSettingsPanel();if(officialCollapsed())officialToggle();document.body.classList.add('dsh-sb-open')}" +
    "function closeSb(){if(!officialCollapsed())officialToggle();document.body.classList.remove('dsh-sb-open')}" +
    "btn.addEventListener('click',function(){if(document.body.classList.contains('dsh-sb-open')){closeSb()}else{openSb()}});" +
    "document.body.appendChild(btn);" +
    "var scrim=document.createElement('div');" +
    "scrim.className='dsh-scrim';" +
    "scrim.addEventListener('click',function(){closeSb()});" +
    "document.body.appendChild(scrim);" +
    "var sb=document.querySelector('.pI_x6G_sidebarCol');" +
    "if(sb){sb.addEventListener('click',function(e){" +
    "if(e.target.closest('.hHd-Xa_newSession')||e.target.closest('[data-session-id]')||e.target.closest('.VOzbGW_trigger')){" +
    "setTimeout(closeSb,150)" +
    "}})}" +
    // N3: 键盘 shift（APK 经 window.__dshSetKb 注入）
    "window.__dshSetKb=function(cssPx){" +
    "var kb=Math.max(0,cssPx||0);" +
    "document.documentElement.style.setProperty('--keyboard-shift',kb+'px');" +
    "if(kb>0){document.body.classList.add('dsh-kb-open')}else{document.body.classList.remove('dsh-kb-open')}" +
    "if(kb>0){setTimeout(function(){var el=document.querySelector('.Md3f7G_scroll');if(el)el.scrollTop=el.scrollHeight},120)}" +
    "};" +
    // N2: 窗口尺寸变化时重新应用 safe-area
    "window.addEventListener('resize',applySafe);" +
    "setTimeout(applySafe,500);" +
    // N6 改版: 侧栏设置按钮上方注入「返回连接页」（官方 trigger 同款样式）+ 设置面板 header 注入「扫码」按钮
    "var injectedScan=false;" +
    "var scanObs=new MutationObserver(function(){" +
    "if(injectedScan)return;" +
    "var sa=document.querySelector('.hHd-Xa_settingsArea');" +
    "var h=document.querySelector('.VOzbGW_header .VOzbGW_actions');" +
    "if(!sa)return;" +
    "injectedScan=true;" +
    "if(!document.getElementById('dsh-back-conn')){" +
    "var bb=document.createElement('button');" +
    "bb.type='button';" +
    "bb.id='dsh-back-conn';" +
    "bb.style.cssText='box-sizing:border-box;cursor:pointer;width:calc(100% + 8px);height:34px;color:var(--dsw-alias-label-primary, #f9fafb);background:transparent;border:none;border-radius:12px;flex:none;align-items:center;gap:8px;margin:4px -4px;padding:4px 2px 4px 8px;font-family:inherit;font-size:14px;line-height:22px;display:flex;overflow:hidden';" +
    "bb.innerHTML='<img src=\"__BACK_ICON_B64__\" alt=\"\" style=\"width:24px;height:24px;border-radius:6px;flex:none;object-fit:cover\"/><span style=\"white-space:nowrap;overflow:hidden;text-overflow:ellipsis\">返回连接页</span>';" +
    "bb.addEventListener('mouseenter',function(){bb.style.background='var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.08))'});" +
    "bb.addEventListener('mouseleave',function(){bb.style.background='transparent'});" +
    "bb.addEventListener('click',function(){try{if(window.DshMiniBridge&&DshMiniBridge.gotoConnect){DshMiniBridge.gotoConnect()}else{alert('请在 DSH-Mobile 应用内使用')}}catch(e){}});" +
    "sa.insertBefore(bb,sa.firstChild)}" +
    "if(h){var sb2=document.createElement('button');" +
    "sb2.type='button';" +
    "sb2.style.cssText='cursor:pointer;width:28px;height:28px;background:rgba(255,255,255,.08);border:none;border-radius:28px;display:inline-flex;justify-content:center;align-items:center;font-size:15px;color:#cfd3d6;flex:none';" +
    "sb2.setAttribute('aria-label','扫码连接');" +
    "sb2.innerHTML='&#128247;';" +
    "sb2.addEventListener('click',function(){try{if(window.DshMiniBridge&&DshMiniBridge.startScan){DshMiniBridge.startScan()}else{alert('请在 DSH-Mobile 应用内使用扫码')}}catch(e){}});" +
    "h.insertBefore(sb2,h.firstChild)}" +
    "});" +
    "scanObs.observe(document.documentElement,{subtree:true,childList:true});" +
    "}" +
    "if(document.readyState==='loading'){document.addEventListener('DOMContentLoaded',init)}else{init()}" +
    "})()";
  // 返回连接页按钮图标：gui/assets/back-icon.png（base64 内嵌，图片文件缺失时退回 ⬅ emoji）
  let backIconB64 = "";
  try {
    backIconB64 = "data:image/png;base64," + readFileSync(join(GUI_DIR, "assets", "back-icon.png")).toString("base64");
  } catch {
    backIconB64 = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text y="18" font-size="16">⬅</text></svg>').toString("base64");
  }
  const mobileJs = mobileJsTpl.split("__BACK_ICON_B64__").join(backIconB64);
  const mobilePatch =
    "<style id=\"dsh-mobile-patch\">" + mobileCss + "</style>" +
    "<script>" + mobileJs + "</script>";
  const injected =
    "<script>window.__DSH_BOOT__ = " + boot + "</script>";
  html = html.replace("<head>", "<head>" + polyfill + mobilePatch + injected);
  guiIndexCache = { rev, html };
  return html;
}

function serveGuiStatic(res, filePath, cacheSecs = 3600) {
  const target = safeResolve(GUI_DIST, filePath);
  if (!target || !existsSync(target) || statSync(target).isDirectory()) {
    sendText(res, 404, "not found", "text/plain; charset=utf-8");
    return;
  }
  const body = readFileSync(target);
  res.writeHead(200, {
    "Content-Type": contentTypeFor(target),
    "Cache-Control": "public, max-age=" + cacheSecs,
    "Access-Control-Allow-Origin": "*",
  });
  res.end(body);
}

function serveGui(req, res, u, url) {
  if (u === "/") {
    const html = buildGuiledIndex();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(html);
    return;
  }
  if (u.startsWith("/assets/")) return serveGuiStatic(res, u, 86400);
  if (u === "/manifest.webmanifest" || u === "/favicon.svg") return serveGuiStatic(res, u, 86400);
  if (u.startsWith("/plugins/")) {
    // /plugins/<id>/client.js[?rev=...] -> gui/bundles/<id>/client.js
    const m = /^\/plugins\/(.+)\/client\.js$/.exec(u);
    if (!m) {
      sendText(res, 404, "not found", "text/plain; charset=utf-8");
      return;
    }
    const id = decodeURIComponent(m[1]);
    const target = safeResolve(GUI_BUNDLES, "/" + id.replace(/\\/g, "/") + "/client.js");
    if (!target || !existsSync(target)) {
      sendText(res, 404, "bundle not found: " + id, "text/plain; charset=utf-8");
      return;
    }
    const body = readFileSync(target);
    res.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  } else {
    sendText(res, 404, "not found", "text/plain; charset=utf-8");
  }
}

// 旧 /dsh-mini/* 协议反向代理到主端口（保持 APK connect / health 兼容）
function proxyToUpstream(req, res) {
  const headers = { ...req.headers };
  headers.host = `${gwUpstreamHost}:${gwUpstreamPort}`;
  headers["x-dsh-mini-gateway"] = "1";
  const upstream = httpRequest(
    { hostname: "127.0.0.1", port: gwUpstreamPort, path: req.url, method: req.method, headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.on("error", () => {
        try {
          res.destroy();
        } catch {
          /* ignore */
        }
      });
      up.pipe(res);
    },
  );
  upstream.on("error", (e) => {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      res.end("dsh-mini gateway: upstream error (" + e.message + ")");
    } else {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
  });
  req.on("error", () => {
    upstream.destroy();
  });
  req.on("aborted", () => {
    upstream.destroy();
  });
  // NOTE: do NOT listen to req 'close' — for body-less GET requests that
  // fires the moment the request is parsed, which would kill every
  // proxied request instantly (socket hang). Track the RESPONSE side.
  res.on("close", () => {
    if (!res.writableFinished) {
      try {
        upstream.destroy();
      } catch {
        /* ignore */
      }
    }
  });
  req.pipe(upstream);
}

function startGateway(ctx) {
  stopGateway();
  const cfg = loadConfig();
  if (!cfg.lanEnabled) return;
  const ws = ctx.get("webServer");
  const upstreamPort = (ws && ws.port) || 0;
  if (!upstreamPort) {
    gwListenError = "主 webServer 端口未知，网关未启动";
    console.warn("[dsh-mini] gateway: " + gwListenError);
    return;
  }
  gwUpstreamPort = upstreamPort;
  gwUpstreamHost = (ws && ws.host) || "127.0.0.1";
  const port = cfg.gatewayPort;
  // GUI RPC：POST /api/<method>（官方信封 {type:'client-request',rpcId,method,payload}）
  const handleGuiPost = (req, res, methodName) => {
    if (req.method !== "POST") {
      sendJson(res, 405, { error: "method not allowed" });
      return;
    }
    readBody(req, 16 * 1024 * 1024)
      .then((raw) => {
        let envelope;
        try {
          envelope = JSON.parse(raw || "{}");
        } catch {
          sendJson(res, 400, { error: "invalid JSON body" });
          return;
        }
        const method = (envelope && envelope.method) || methodName;
        const rpcId = envelope && envelope.rpcId != null ? envelope.rpcId : "n/a";
        const payload = (envelope && envelope.payload) || {};
        handleGuiApi(ctx, method, payload)
          .then((value) => {
            sendJson(res, 200, { type: "server-response", rpcId, result: { ok: true, value } });
          })
          .catch((err) => {
            // 官方 rpcErrorSchema 要求 code 在枚举内且 details 必填 —— 兜底统一 internal
            const e =
              err instanceof RpcError
                ? err
                : new RpcError("internal", String((err && err.message) || err));
            const error = { code: e.code, message: e.message, details: e.details !== undefined ? e.details : {} };
            sendJson(res, 200, { type: "server-response", rpcId, result: { ok: false, error } });
          });
      })
      .catch(() => sendJson(res, 400, { error: "body read failed" }));
  };
  const server = createServer((req, res) => {
    const u = (req.url || "/").split("?")[0];
    // 旧 dsh-mini 协议 → 代理到主端口（保持兼容）
    if (u === APP_PREFIX || u.startsWith(APP_PREFIX + "/")) {
      proxyToUpstream(req, res);
      return;
    }
    // GUI RPC：POST /api/<method>（官方前端同源相对路径调用）
    if (u.startsWith("/api/") && u !== "/api/events.mux" && u !== "/api/events.host") {
      let url;
      try {
        url = new URL(req.url, "http://x");
      } catch {
        url = new URL("/", "http://x");
      }
      if (!authGuiRequest(req, res, url)) return; // 403 或 302 已发
      handleGuiPost(req, res, u.slice("/api/".length));
      return;
    }
    // GUI 应用服务器（根路径 + 静态资源 + 插件 bundle）
    if (
      u === "/" ||
      u.startsWith("/assets/") ||
      u.startsWith("/plugins/") ||
      u === "/manifest.webmanifest" ||
      u === "/favicon.svg"
    ) {
      let url;
      try {
        url = new URL(req.url, "http://x");
      } catch {
        url = new URL("/", "http://x");
      }
      if (!authGuiRequest(req, res, url)) return; // 403 或 302 已发
      serveGui(req, res, u, url);
      return;
    }
    res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
    res.end("dsh-mini gateway: not found");
  });
  // GUI WebSocket 下推（/api/events.mux + /api/events.host）——server 生命周期注册一次
  attachGuiWs(server, ctx, authGuiWs);
  server.on("error", (e) => {
    gwListening = false;
    gwListenError = String((e && e.message) || e);
    console.warn("[dsh-mini] gateway listen failed on 0.0.0.0:" + port + " — " + gwListenError);
  });
  server.listen(port, "0.0.0.0", () => {
    gwListening = true;
    gwListenError = "";
    console.log(`[dsh-mini] LAN gateway listening on 0.0.0.0:${port} -> ${gwUpstreamHost}:${gwUpstreamPort}`);
  });
  gwServer = server;
}

function gatewayStatus(ctx) {
  const cfg = loadConfig();
  const webServer = ctx.get("webServer");
  const host = (webServer && webServer.host) || "127.0.0.1";
  const port = (webServer && webServer.port) || 0;
  const ips = lanAddresses();
  const reachable = cfg.lanEnabled && gwListening && ips.length > 0;
  const token = effectiveToken();
  let url = "";
  if (cfg.lanEnabled && ips.length) {
    url = `http://${ips[0]}:${cfg.gatewayPort}/?token=${encodeURIComponent(token)}`; // v3: 根路径直接出 GUI
  } else if (port > 0) {
    url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
  }
  let bindWarn = null;
  if (cfg.lanEnabled) {
    if (gwListenError) bindWarn = "LAN 网关启动失败：" + gwListenError;
    else if (!gwListening) bindWarn = "LAN 网关未在监听（正在启动或端口被占用）。";
    else if (ips.length === 0) bindWarn = "未检测到局域网 IPv4 地址，手机无法访问本机。";
  }
  return {
    version: PLUGIN_VERSION,
    token,
    hasToken: Boolean(token),
    lanEnabled: cfg.lanEnabled,
    maxUploadMb: cfg.maxUploadMb,
    gatewayPort: cfg.gatewayPort,
    gatewayListening: gwListening,
    gatewayListenError: gwListenError,
    host,
    port,
    lanIps: ips,
    reachable,
    url,
    bindWarn,
  };
}

// ===========================================================================
// balance cache (M3 — fed by the desktop client half)
// ===========================================================================
let balanceCache = { at: 0, data: null };
// browser client half startup diagnostics (loopback-only, ring buffer)
const clientBeacons = [];


// ===========================================================================
// HTTP dispatch
// ===========================================================================
async function dispatchApi(ctx, req, res, pathname, url) {
  if (!assertAuth(req, res, url)) return;
  const parts = pathname.slice(API_PREFIX.length + 1).split("/").filter(Boolean);
  const method = req.method || "GET";

  try {
    // GET /health
    if (parts.length === 1 && parts[0] === "health" && method === "GET") {
      const servicesReady = Boolean(
        ctx.get("agents") && ctx.get("agentDefaultModel") && ctx.get("sessions"),
      );
      return sendJson(res, 200, { ok: true, name, version: PLUGIN_VERSION, servicesReady });
    }

    // GET /gateway
    if (parts.length === 1 && parts[0] === "gateway" && method === "GET") {
      return sendJson(res, 200, { gateway: gatewayStatus(ctx) });
    }

    // POST /gateway/config  (loopback only — LAN clients cannot change config)
    if (parts.length === 2 && parts[0] === "gateway" && parts[1] === "config" && method === "POST") {
      if (!isLocalDirect(req)) return sendJson(res, 403, { error: "gateway config is loopback-only" });
      const body = await readBody(req);
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, { error: "invalid JSON" });
      }
      const patch = {};
      if (typeof parsed.lanEnabled === "boolean") patch.lanEnabled = parsed.lanEnabled;
      if (parsed.maxUploadMb !== undefined) {
        const n = Number(parsed.maxUploadMb);
        if (!Number.isFinite(n) || n < 1 || n > MAX_UPLOAD_MB_CAP) {
          return sendJson(res, 400, { error: "maxUploadMb must be 1.." + MAX_UPLOAD_MB_CAP });
        }
        patch.maxUploadMb = Math.round(n);
      }
      if (parsed.gatewayPort !== undefined) {
        const n = Number(parsed.gatewayPort);
        if (!Number.isFinite(n) || n < MIN_GATEWAY_PORT || n > MAX_GATEWAY_PORT) {
          return sendJson(res, 400, { error: "gatewayPort must be " + MIN_GATEWAY_PORT + ".." + MAX_GATEWAY_PORT });
        }
        patch.gatewayPort = Math.round(n);
      }
      if (Object.keys(patch).length === 0) {
        return sendJson(res, 400, { error: "nothing to change (lanEnabled?, maxUploadMb?, gatewayPort?)" });
      }
      const cfg = saveConfig(patch);
      startGateway(ctx);
      return sendJson(res, 200, { ok: true, gateway: gatewayStatus(ctx), config: cfg });
    }

    // POST /gateway/token/reset  (loopback only)
    if (parts.length === 3 && parts[0] === "gateway" && parts[1] === "token" && parts[2] === "reset" && method === "POST") {
      if (!isLocalDirect(req)) return sendJson(res, 403, { error: "token reset is loopback-only" });
      const token = resetToken();
      return sendJson(res, 200, { ok: true, token });
    }

    // GET /balance  (data fed by the desktop client half)
    if (parts.length === 1 && parts[0] === "balance" && method === "GET") {
      const data = balanceCache.data;
      if (!data) return sendJson(res, 200, { ok: false, balance: null, note: "waiting for the desktop shell to push balance data" });
      return sendJson(res, 200, { ok: true, balance: data, updatedAt: balanceCache.at });
    }

    // POST /balance/report  (loopback only — desktop client half)
    if (parts.length === 2 && parts[0] === "balance" && parts[1] === "report" && method === "POST") {
      if (!isLocalDirect(req)) return sendJson(res, 403, { error: "balance report is loopback-only" });
      const body = await readBody(req);
      let data;
      try {
        data = JSON.parse(body || "null");
      } catch {
        return sendJson(res, 400, { error: "invalid JSON" });
      }
      balanceCache = { at: Date.now(), data };
      return sendJson(res, 200, { ok: true });
    }

    // GET /client-beacon  (loopback only — browser client half diagnostics)
    if (parts.length === 1 && parts[0] === "client-beacon" && method === "GET") {
      if (!isLocalDirect(req)) return sendJson(res, 403, { error: "client beacon is loopback-only" });
      return sendJson(res, 200, { ok: true, beacons: clientBeacons.slice() });
    }

    // POST /client-beacon  (loopback only — browser client half diagnostics)
    if (parts.length === 1 && parts[0] === "client-beacon" && method === "POST") {
      if (!isLocalDirect(req)) return sendJson(res, 403, { error: "client beacon is loopback-only" });
      const body = await readBody(req);
      let data;
      try {
        data = JSON.parse(body || "{}");
      } catch {
        data = {};
      }
      const entry = {
        t: Date.now(),
        ev: String(data.ev || "beacon"),
        msg: String(data.msg || "").slice(0, 500),
        ua: String(req.headers["user-agent"] || "").slice(0, 120),
      };
      clientBeacons.push(entry);
      if (clientBeacons.length > 50) clientBeacons.shift();
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "not found: " + pathname });
  } catch (err) {
    const status = err.status || 500;
    console.error("[dsh-mini] " + method + " " + pathname + " -> " + status + ": " + (err.message || err));
    if (!res.headersSent) sendJson(res, status, { error: err.message || "internal error" });
  }
}


// ===========================================================================
// plugin entry
// ===========================================================================
function apply(ctx) {
  ensureToken();
  loadConfig();

  // 2) HTTP routes — ONE prefix route, internal dispatch. Self-heal on
  //    re-registration conflicts (hot reload leaves stale fibers behind).
  ctx.effect(() => {
    const route = {
      kind: "prefix",
      path: APP_PREFIX,
      handler: (req, res) => {
        const url = new URL(req.url, "http://localhost");
        const p = url.pathname;
        if (p !== APP_PREFIX && !p.startsWith(APP_PREFIX + "/")) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (p.startsWith(API_PREFIX + "/")) {
          dispatchApi(ctx, req, res, p, url);
        } else {
          // 旧静态手机页（public/index.html）已由 v3 GUI 取代，主端口不再服务
          sendText(res, 404, "not found", "text/plain; charset=utf-8");
        }
      },
    };
    let dispose;
    try {
      dispose = ctx.webServer.register(route);
    } catch (err) {
      try {
        const table = ctx.webServer.prefixes;
        if (table && table.has(route.path)) table.delete(route.path);
        dispose = ctx.webServer.register(route);
        console.warn("[dsh-mini] stale route removed and re-registered: " + route.path);
      } catch (err2) {
        console.warn("[dsh-mini] route registration failed (" + route.path + "): " + String((err2 && err2.message) || err2));
        dispose = null;
      }
    }
    return () => {
      try {
        if (dispose) dispose();
      } catch {
        /* ignore */
      }
    };
  }, "dsh-mini: http routes");

  // 3) LAN gateway — standalone 0.0.0.0 listener that reverse-proxies the
  //    /dsh-mini prefix to the main webServer (loopback), forcing token auth.
  ctx.effect(() => {
    startGateway(ctx);
    return () => stopGateway();
  }, "dsh-mini: lan gateway");

  // 4) Startup log + gateway summary.
  const token = ensureToken();
  const gw = gatewayStatus(ctx);
  console.log(`[dsh-mini] v${PLUGIN_VERSION} mounted at ${APP_PREFIX}/ (api: ${API_PREFIX}/)`);
  console.log(`[dsh-mini] webServer bind: ${gw.host}:${gw.port}; LAN gateway ${gw.lanEnabled ? "ENABLED" : "disabled"}; LAN IPs: ${gw.lanIps.join(", ") || "(none)"}`);
  console.log(`[dsh-mini] bridge token (share with the phone app): ${token}`);
  if (gw.gatewayListening) {
    console.log(`[dsh-mini] gateway listening on 0.0.0.0:${gw.gatewayPort}`);
  } else if (gw.bindWarn) {
    console.warn(`[dsh-mini] gateway not listening: ${gw.bindWarn}`);
  }
  if (gw.reachable) {
    console.log(`[dsh-mini] phone connect URL: ${gw.url}`);
  } else {
    console.log(`[dsh-mini] loopback URL: ${gw.url} (enable the LAN gateway in DSH settings to reach from a phone)`);
  }
}

export { name, inject, apply };
