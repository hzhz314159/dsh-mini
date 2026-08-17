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

import { randomUUID } from "node:crypto";
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
import { join, normalize, extname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

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
const MINI_HOME = join(homedir(), ".dsh", "dsh-mini");
const UPLOADS_ROOT = join(MINI_HOME, "uploads");

const MAX_BODY_BYTES = Number(process.env.DSH_MINI_MAX_BODY || 8 * 1024 * 1024);
const DEFAULT_MAX_UPLOAD_MB = 20;
const MAX_UPLOAD_MB_CAP = 100;
const DEFAULT_GATEWAY_PORT = 46322;
const MIN_GATEWAY_PORT = 1024;
const MAX_GATEWAY_PORT = 65535;
const MAX_LOG_EVENTS = 4000; // raw events scanned per history pull
const MAX_BUFFER_STEPS = 3000; // live mirror per watched session
const FILE_MAP_TTL_MS = 60_000;
const CATALOG_TTL_MS = 60_000;

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

function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
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
// per-session model selection store (~/.dsh/dsh-mini/sessions.json)
// ===========================================================================
function sessionsStoreFile() {
  return join(MINI_HOME, "sessions.json");
}

function readSessionsStore() {
  try {
    return JSON.parse(readFileSync(sessionsStoreFile(), "utf8"));
  } catch {
    return {};
  }
}

function writeSessionsStore(store) {
  mkdirSync(MINI_HOME, { recursive: true });
  // prune to the newest 200 entries
  const entries = Object.entries(store);
  if (entries.length > 200) {
    entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
    store = Object.fromEntries(entries.slice(0, 200));
  }
  writeFileSync(sessionsStoreFile(), JSON.stringify(store, null, 2), "utf8");
}

function getStoredSelection(sessionId) {
  const s = readSessionsStore()[sessionId];
  if (s && s.provider && s.model) {
    return { provider: s.provider, model: s.model, reasoningEffort: s.reasoningEffort || undefined };
  }
  return null;
}

function setStoredSelection(sessionId, sel) {
  const store = readSessionsStore();
  store[sessionId] = { ...sel, at: Date.now() };
  writeSessionsStore(store);
}

// ===========================================================================
// zstd-framed session log reading (dsh-side-session pattern)
// ===========================================================================
const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 LE

function scanFrame(buf, offset) {
  if (buf.length - offset < 4) return null;
  if (buf.readUInt32LE(offset) !== ZSTD_MAGIC) return null;
  let o = offset + 4;
  const desc = buf.readUInt8(o++);
  if ((desc & 24) !== 0) return null;
  const csf = desc >>> 6;
  const singleSeg = (desc & 32) !== 0;
  const checksum = (desc & 4) !== 0;
  const dictFlag = desc & 3;
  const dictBytes = dictFlag === 3 ? 4 : dictFlag;
  const contentSizeBytes = csf === 0 ? (singleSeg ? 1 : 0) : 1 << csf;
  let remaining = (singleSeg ? 0 : 1) + dictBytes + contentSizeBytes;
  if (buf.length - o < remaining) return null;
  o += remaining;
  for (;;) {
    if (buf.length - o < 3) return null;
    const bh = buf.readUIntLE(o, 3);
    o += 3;
    const last = (bh & 1) !== 0;
    const bt = (bh >>> 1) & 3;
    const bs = bh >>> 3;
    if (bt === 3) return null;
    const payload = bt === 1 ? 1 : bs;
    if (buf.length - o < payload) return null;
    o += payload;
    if (last) break;
  }
  if (checksum) o += 4;
  return { start: offset, end: o };
}

function decompressZstd(buf) {
  let offset = 0;
  let out = "";
  for (;;) {
    const f = scanFrame(buf, offset);
    if (!f) break;
    try {
      out += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    } catch {
      break;
    }
    offset = f.end;
    if (offset >= buf.length) break;
  }
  return out;
}

function decompressFrames(buf, from) {
  let offset = from;
  let out = "";
  for (;;) {
    const f = scanFrame(buf, offset);
    if (!f) break;
    try {
      out += zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8");
    } catch {
      break;
    }
    offset = f.end;
    if (offset >= buf.length) break;
  }
  return { text: out, end: offset };
}

// Walk <dshHome>/sessions/**/session.jsonl.zstd once, mapping session id -> file.
// The first line of the first frame carries the session id (side-session
// findSessionFile pattern).
let fileMapCache = { at: 0, map: new Map() };

function walkSessionFiles() {
  const now = Date.now();
  if (now - fileMapCache.at < FILE_MAP_TTL_MS && fileMapCache.map.size > 0) {
    return fileMapCache.map;
  }
  const map = new Map();
  const root = join(dshHome(), "sessions");
  const visit = (dir, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) visit(join(dir, e.name), depth + 1);
      else if (e.name === "session.jsonl.zstd" || e.name === "session.jsonl") {
        try {
          const p = join(dir, e.name);
          const buf = readFileSync(p);
          let head = null;
          if (e.name.endsWith(".zstd")) {
            const f = scanFrame(buf, 0);
            if (f) {
              try {
                head = JSON.parse(
                  zstdDecompressSync(buf.subarray(f.start, f.end)).toString("utf8").split("\n", 1)[0]
                );
              } catch {}
            }
          } else {
            try {
              head = JSON.parse(buf.toString("utf8").split("\n", 1)[0]);
            } catch {}
          }
          const id = head && head.id;
          if (typeof id === "string" && !map.has(id)) map.set(id, p);
        } catch {
          /* skip */
        }
      }
    }
  };
  try {
    visit(root, 0);
  } catch {}
  fileMapCache = { at: now, map };
  return map;
}

function findSessionFile(sessionId) {
  const map = walkSessionFiles();
  if (map.has(sessionId)) return map.get(sessionId);
  // tolerate "session-" prefix mismatch both ways
  const cands = [];
  if (sessionId.startsWith("session-")) cands.push(sessionId.slice("session-".length));
  else cands.push("session-" + sessionId);
  for (const c of cands) {
    if (map.has(c)) return map.get(c);
  }
  return "";
}

// Fold helpers over raw log events.
function freshFoldState() {
  return { events: [], title: "", model: null, updatedAt: 0 };
}

// Apply raw log events into a fold state in place (incremental + full share
// this exact semantics; logs are append-only so last-wins folding is stable).
function foldInto(state, evs) {
  for (const ev of evs) {
    if (!ev || typeof ev !== "object") continue;
    if (typeof ev.time === "number" && ev.time > state.updatedAt) state.updatedAt = ev.time;
    if (ev.type === "session/title" && ev.data && typeof ev.data.title === "string") {
      state.title = ev.data.title;
    } else if (ev.type === "session" && typeof ev.title === "string") {
      state.title = ev.title;
    } else if (ev.type === "request/header" && ev.data) {
      const cfg = (ev.data.config || (ev.data.header && ev.data.header.config)) || null;
      if (cfg && cfg.provider && cfg.model) {
        state.model = {
          provider: String(cfg.provider),
          model: String(cfg.model),
          reasoningEffort: cfg.reasoningEffort !== undefined ? cfg.reasoningEffort : undefined,
        };
      }
    } else if (ev.type === "request/context" && ev.data && ev.data.provider && ev.data.model) {
      if (state.model) {
        state.model.provider = String(ev.data.provider);
        state.model.model = String(ev.data.model);
      } else {
        state.model = { provider: String(ev.data.provider), model: String(ev.data.model), reasoningEffort: undefined };
      }
    }
    state.events.push(ev);
  }
  if (state.events.length > MAX_LOG_EVENTS) {
    state.events = state.events.slice(state.events.length - MAX_LOG_EVENTS);
  }
}

// Incremental fold cache: file -> { mtimeMs, size, firstMagic, frameEnd, state }
const foldCache = new Map();
function capMap(map, max) {
  if (map.size <= max) return;
  let extra = map.size - max;
  for (const key of map.keys()) {
    map.delete(key);
    if (--extra <= 0) break;
  }
}

function foldLogEvents(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { events: [], title: "", model: null, updatedAt: 0 };
  }
  const cached = foldCache.get(file);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.state;
  }
  const buf = readFileSync(file);
  const firstMagic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
  const isZstd = firstMagic === ZSTD_MAGIC;
  let state = null;
  let frameEnd = 0;
  if (
    isZstd &&
    cached &&
    cached.isZstd &&
    cached.firstMagic === firstMagic &&
    cached.frameEnd > 0 &&
    cached.frameEnd <= buf.length &&
    cached.size <= st.size
  ) {
    const inc = decompressFrames(buf, cached.frameEnd);
    if (inc.text) {
      state = cached.state;
      foldInto(state, parseLines(inc.text));
      frameEnd = inc.end;
    } else {
      // no complete new frame (half-written tail): keep old state + boundary
      state = cached.state;
      frameEnd = cached.frameEnd;
    }
  }
  if (!state) {
    // full parse (no cache / file replaced / boundary invalidated)
    let raw;
    if (isZstd) {
      raw = decompressZstd(buf);
    } else {
      raw = buf.toString("utf8");
    }
    state = freshFoldState();
    foldInto(state, parseLines(raw));
    frameEnd = isZstd ? decompressFrames(buf, 0).end : buf.length;
  }
  const entry = { mtimeMs: st.mtimeMs, size: st.size, firstMagic, isZstd, frameEnd, state };
  foldCache.set(file, entry);
  capMap(foldCache, 200);
  return state;
}

function parseLines(text) {
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ===========================================================================
// model selection
// ===========================================================================
function resolveDefaultSelection(ctx) {
  const svc = ctx.get("agentDefaultModel");
  if (!svc) return null;
  try {
    if (typeof svc.currentSelection === "function") {
      const sel = svc.currentSelection();
      if (sel && sel.provider && sel.model) {
        return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || undefined };
      }
    }
  } catch {
    /* fall through */
  }
  if (svc && typeof svc === "object" && svc.provider && svc.model) {
    return { provider: svc.provider, model: svc.model, reasoningEffort: svc.reasoningEffort || undefined };
  }
  return null;
}

// Caller-held mutable selection objects per live session (installModelSelection
// contract: the listener snapshots selection.current on every request).
const liveSelections = new Map();

function currentSelectionFor(ctx, sessionId) {
  const stored = getStoredSelection(sessionId);
  if (stored) return { ...stored, source: "phone" };
  const sessions = ctx.get("sessions");
  const session = sessions && sessions.get ? sessions.get(sessionId) : null;
  if (session && typeof session.requestHeader === "function") {
    try {
      const h = session.requestHeader();
      const cfg = h && h.config;
      if (cfg && cfg.provider && cfg.model) {
        return { provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort || undefined, source: "session" };
      }
    } catch {
      /* ignore */
    }
  }
  const file = findSessionFile(sessionId);
  if (file) {
    const fold = foldLogEvents(file);
    if (fold.model) return { ...fold.model, source: "log" };
  }
  const def = resolveDefaultSelection(ctx);
  if (def) return { ...def, source: "default" };
  return null;
}

// ===========================================================================
// event normalization -> phone-facing step
// ===========================================================================
function resultText(message) {
  if (!message) return "";
  const blocks = message.content || [];
  return blocks
    .filter((b) => b && b.type === "text")
    .map((b) => b.text || "")
    .join("");
}

function resultIsError(message) {
  if (!message) return false;
  if (typeof message.isError === "boolean") return message.isError;
  const blocks = message.content || [];
  return blocks.some((b) => b && b.type === "text" && /error/i.test(b.text || ""));
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

// Map a raw session/event into the phone step schema. Returns null to skip.
function normalizeEvent(event) {
  const seq = event.seq;
  switch (event.type) {
    case "assistant/chunk": {
      const chunk = event.data?.chunk;
      if (!chunk || typeof chunk.text !== "string") return null;
      if (chunk.type === "reasoning-delta") return { seq, type: "thinking", text: chunk.text };
      if (chunk.type === "text-delta") return { seq, type: "assistant", text: chunk.text };
      return null;
    }
    case "assistant/message": {
      const text = messageText(event.data?.message?.content);
      return { seq, type: "assistant", text, committed: true };
    }
    case "user/message": {
      const text = messageText(event.data?.content);
      if (!text) return null;
      return { seq, type: "user", text };
    }
    case "tool/call": {
      const d = event.data || {};
      let args = "";
      try {
        args = typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments);
      } catch {
        /* ignore */
      }
      return { seq, type: "tool", status: "call", tool: d.name, callId: d.callId, text: args };
    }
    case "tool/result": {
      const msg = event.data?.message;
      return {
        seq,
        type: "tool",
        status: "result",
        callId: msg?.source?.callId,
        text: resultText(msg),
        isError: resultIsError(msg),
      };
    }
    case "turn/start":
      return { seq, type: "status", status: "turn-start" };
    case "turn/end": {
      const reason = event.data?.reason || {};
      const kind = reason.kind || "completed";
      return { seq, type: "status", status: "turn-end", reason: kind, detail: reason };
    }
    case "session/title": {
      const title = event.data?.title;
      if (typeof title !== "string" || !title) return null;
      return { seq, type: "title", title };
    }
    case "request/header": {
      const cfg = (event.data?.config || (event.data?.header && event.data.header.config)) || null;
      if (!cfg || (!cfg.provider && !cfg.model)) return null;
      return {
        seq,
        type: "model",
        provider: cfg.provider || null,
        model: cfg.model || null,
        reasoningEffort: cfg.reasoningEffort || null,
      };
    }
    case "request/context": {
      const d = event.data || {};
      if (!d.provider && !d.model) return null;
      return { seq, type: "model", provider: d.provider || null, model: d.model || null, reasoningEffort: null };
    }
    default:
      return null;
  }
}

// ===========================================================================
// live mirror buffers (seq-deduped, per watched session)
// ===========================================================================
const buffers = new Map(); // sessionId -> [{ seq, time, step }]
const watched = new Set();

function watchSession(sessionId) {
  watched.add(sessionId);
}

function bufferPush(sessionId, event, step) {
  if (!watched.has(sessionId)) return;
  let buf = buffers.get(sessionId);
  if (!buf) {
    buf = [];
    buffers.set(sessionId, buf);
  }
  buf.push({ seq: event.seq, time: event.time, step });
  if (buf.length > MAX_BUFFER_STEPS) buf.splice(0, buf.length - MAX_BUFFER_STEPS);
}

function bufferTail(sessionId) {
  const buf = buffers.get(sessionId);
  return buf || [];
}

// ===========================================================================
// session driving (every session is a real DSH session on the computer)
// ===========================================================================
async function getOrAttach(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (!agents) throw httpError(503, "DSH agents service unavailable");
  const live = agents.get ? agents.get(sessionId) : void 0;
  if (live !== void 0) return live;
  const selection = currentSelectionFor(ctx, sessionId);
  if (!selection) throw httpError(503, "no model configured (set a default model in DSH)");
  const persistence = ctx.get("sessionPersistence");
  if (persistence && persistence.list) {
    const stored = (await persistence.list()).find((h) => h && h.id === sessionId);
    if (stored) {
      const sel = { current: { ...selection }, assembled: void 0 };
      const { agent } = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, sel);
        },
      });
      liveSelections.set(sessionId, sel);
      watchSession(sessionId);
      await agent.whenIdle();
      return agent;
    }
  }
  throw httpError(404, "session not found: " + sessionId);
}

async function newSession(ctx, cwd) {
  const agents = ctx.get("agents");
  if (!agents) throw httpError(503, "DSH agents service unavailable");
  const selection = resolveDefaultSelection(ctx);
  if (!selection) throw httpError(503, "no model configured (set a default model in DSH)");
  const workdir =
    cwd && String(cwd).trim()
      ? String(cwd).trim()
      : join(MINI_HOME, "workspace", randomUUID().slice(0, 8));
  try {
    mkdirSync(workdir, { recursive: true });
  } catch {
    /* ignore */
  }
  const sel = { current: { ...selection }, assembled: void 0 };
  const { agent } = await agents.create({
    sessionId: SessionId("dsh-mini-" + randomUUID()),
    meta: { cwd: workdir },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, sel);
    },
  });
  liveSelections.set(agent.session.id, sel);
  watchSession(agent.session.id);
  await agent.whenIdle();
  return agent;
}

// 把长 UUID / dsh-mini-<uuid> 缩短成可读兜底标题，避免列表全是机器串。
function shortId(id) {
  if (!id) return "会话";
  const s = String(id);
  if (s.startsWith("dsh-mini-")) return "新会话 " + s.slice("dsh-mini-".length, "dsh-mini-".length + 6);
  if (s.length >= 32 && /^[0-9a-f-]+$/i.test(s)) return "会话 " + s.slice(0, 8);
  return s.length > 16 ? s.slice(0, 16) : s;
}

async function listThreads(ctx) {
  const out = [];
  const persistence = ctx.get("sessionPersistence");
  const agents = ctx.get("agents");
  const sessions = ctx.get("sessions");
  const sessionTitle = ctx.get("sessionTitle");
  const headers = [];
  if (persistence && persistence.list) {
    try {
      headers.push(...(await persistence.list()));
    } catch (err) {
      console.error("[dsh-mini] listThreads error: " + String(err?.message || err));
      return out;
    }
  }
  for (const h of headers) {
    const id = h && h.id;
    if (!id) continue;
    const live = agents && agents.get ? agents.get(id) : void 0;
    const session = sessions && sessions.get ? sessions.get(id) : null;
    let title = "";
    let model = null;
    let updatedAt = 0;
    if (session) {
      // live title from the session-title service; model from the session's
      // own request header fold; updatedAt from our live mirror tail.
      try {
        const snap = sessionTitle && sessionTitle.get ? sessionTitle.get(session) : null;
        if (snap && snap.title) title = snap.title;
      } catch {
        /* ignore */
      }
      try {
        if (session.requestHeader) {
          const cfg = session.requestHeader()?.config;
          if (cfg && cfg.provider && cfg.model) model = { provider: cfg.provider, model: cfg.model, reasoningEffort: cfg.reasoningEffort || null };
        }
      } catch {
        /* ignore */
      }
      const tail = bufferTail(id);
      if (tail.length) updatedAt = tail[tail.length - 1].time || 0;
      if (!title) title = shortId(id);
      if (!model) {
        const sel = currentSelectionFor(ctx, id);
        if (sel) model = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || null };
      }
    } else {
      // stored session: fold its zstd log for title/model/last activity
      const file = findSessionFile(id);
      if (file) {
        const fold = foldLogEvents(file);
        title = fold.title || shortId(id);
        model = fold.model
          ? { provider: fold.model.provider, model: fold.model.model, reasoningEffort: fold.model.reasoningEffort || null }
          : null;
        updatedAt = fold.updatedAt;
      } else {
        title = shortId(id);
      }
    }
    out.push({
      id,
      title,
      cwd: h.cwd || null,
      model,
      updatedAt: updatedAt || h.createdAt || 0,
      live: Boolean(live),
    });
  }
  return out.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
}

// 手机端新建会话的工作区选择器数据源：桌面 workspace 域 registry 优先，
// 历史会话 cwd 去重兜底（排除纯 hash 随机目录）；「默认工作区」恒有。
async function listWorkspaces(ctx) {
  const out = [];
  const seen = new Set();
  const seg = (p) => String(p || "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
  const push = (id, label, cwd) => {
    if (!cwd || seen.has(cwd)) return;
    seen.add(cwd);
    out.push({ id: String(id), label: label || seg(cwd), cwd: String(cwd) });
  };
  push("default", "默认工作区", join(MINI_HOME, "workspace"));
  try {
    const registry = ctx.get("workspaceRegistry");
    if (registry && typeof registry.list === "function") {
      for (const w of registry.list()) {
        if (!w || !w.path) continue;
        const wid = w.id ?? w.workspaceId ?? w.key ?? ("ws:" + w.path);
        push(wid, w.title || seg(w.path), w.path);
      }
    }
  } catch {
    /* ignore */
  }
  try {
    const persistence = ctx.get("sessionPersistence");
    if (persistence && typeof persistence.list === "function") {
      const headers = await persistence.list();
      for (const h of headers || []) {
        const cwd = h && h.cwd;
        if (cwd && !/^[0-9a-f]{8,}$/i.test(seg(cwd))) push("hist:" + cwd, null, cwd);
      }
    }
  } catch {
    /* ignore */
  }
  return { workspaces: out };
}

// 把历史 steps 合并成手机端渲染友好的 segments：连续 thinking/assistant/tool 各自
// 合并为一段（4597 条 → 数百条），前端分片渲染避免逐 step 强制布局。桌面端不受影响
// （该端点为 /dsh-mini 私有路由）。segment 均带 seqMax（段内最大 seq）供增量同步使用。
function buildSegments(steps) {
  const segs = [];
  let i = 0;
  const n = steps.length;
  while (i < n) {
    const s = steps[i];
    if (s.type === "assistant" || s.type === "thinking") {
      let j = i + 1;
      let text = s.text || "";
      while (j < n && steps[j].type === s.type) {
        text += steps[j].text || "";
        j++;
      }
      segs.push({ type: s.type, seqMax: steps[j - 1].seq, text });
      i = j;
    } else if (s.type === "tool") {
      let j = i + 1;
      const items = [{ seq: s.seq, status: s.status, tool: s.tool || null, callId: s.callId || null, text: s.text || "", isError: !!s.isError }];
      while (j < n && steps[j].type === "tool") {
        const t = steps[j];
        items.push({ seq: t.seq, status: t.status, tool: t.tool || null, callId: t.callId || null, text: t.text || "", isError: !!t.isError });
        j++;
      }
      segs.push({ type: "tools", seqMax: steps[j - 1].seq, items });
      i = j;
    } else {
      segs.push(Object.assign({}, s, { seqMax: s.seq }));
      i++;
    }
  }
  return segs;
}

async function getHistory(ctx, sessionId) {
  const sessions = ctx.get("sessions");
  const session = sessions && sessions.get ? sessions.get(sessionId) : null;
  let steps = [];
  let title = "";
  let model = null;
  let cwd = null;
  if (session) {
    const storeEvents = session.events || [];
    const storeSeqs = new Set();
    for (const event of storeEvents) {
      const norm = normalizeEvent(event);
      if (norm) {
        steps.push(norm);
        storeSeqs.add(event.seq);
      }
    }
    for (const entry of bufferTail(sessionId)) {
      if (storeSeqs.has(entry.seq)) continue;
      steps.push(entry.step);
    }
    const header = session.header || {};
    cwd = header.cwd || null;
    try {
      const sessionTitle = ctx.get("sessionTitle");
      const snap = sessionTitle && sessionTitle.get ? sessionTitle.get(session) : null;
      if (snap && snap.title) title = snap.title;
    } catch {
      /* ignore */
    }
    const sel = currentSelectionFor(ctx, sessionId);
    if (sel) model = { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || null };
  } else {
    const file = findSessionFile(sessionId);
    if (!file) return null;
    const fold = foldLogEvents(file);
    for (const ev of fold.events) {
      const norm = normalizeEvent(ev);
      if (norm) steps.push(norm);
    }
    title = fold.title;
    model = fold.model
      ? { provider: fold.model.provider, model: fold.model.model, reasoningEffort: fold.model.reasoningEffort || null }
      : null;
    const persistence = ctx.get("sessionPersistence");
    try {
      const headers = persistence && persistence.list ? await persistence.list() : [];
      const h = headers.find((x) => x && x.id === sessionId);
      cwd = (h && h.cwd) || null;
    } catch {
      /* ignore */
    }
  }
  watchSession(sessionId);
  const segments = buildSegments(steps);
  return {
    id: sessionId,
    title: title || shortId(sessionId),
    cwd,
    model,
    steps,
    segments,
    revision: steps.length ? steps[steps.length - 1].seq : 0,
  };
}

// ===========================================================================
// model catalog (M2)
// ===========================================================================
let catalogCache = { at: 0, data: null };

async function getModelCatalog(ctx) {
  const now = Date.now();
  if (catalogCache.data && now - catalogCache.at < CATALOG_TTL_MS) return catalogCache.data;
  const llm = ctx.get("llm");
  if (!llm || typeof llm.listProviders !== "function") {
    throw httpError(503, "DSH llm service unavailable");
  }
  const providers = llm.listProviders();
  const models = [];
  for (const p of providers) {
    if (!p || !p.id) continue;
    let listed;
    try {
      listed = await llm.listModels(p.id);
    } catch {
      continue;
    }
    for (const m of listed || []) {
      let info = null;
      try {
        if (typeof llm.resolveModelInfo === "function") {
          info = await llm.resolveModelInfo(p.id, m.id);
        }
      } catch {
        /* tolerate adapters that reject resolveModelInfo */
      }
      const reasoning = info && info.reasoning;
      models.push({
        provider: m.provider || p.id,
        model: m.id,
        name: m.name || m.id,
        description: m.description || null,
        inputModalities: Array.isArray(m.inputModalities) ? m.inputModalities : null,
        contextWindow: (info && info.context && info.context.contextWindow) || null,
        maxTokens: info && info.defaultMaxTokens ? info.defaultMaxTokens : null,
        reasoningEfforts: reasoning && Array.isArray(reasoning.efforts)
          ? reasoning.efforts.map((e) => ({ id: e.id, name: e.name || e.id }))
          : [],
        defaultReasoningEffort: (reasoning && reasoning.defaultEffort) || null,
      });
    }
  }
  const def = resolveDefaultSelection(ctx);
  const data = { models, default: def || null, generatedAt: now };
  catalogCache = { at: now, data };
  return data;
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
  const server = createServer((req, res) => {
    const u = req.url || "/";
    // only /dsh-mini is exposed on the LAN; everything else is refused
    if (u !== APP_PREFIX && !u.startsWith(APP_PREFIX + "/")) {
      res.writeHead(404, { "Access-Control-Allow-Origin": "*" });
      res.end("dsh-mini gateway: only /dsh-mini is served");
      return;
    }
    const headers = { ...req.headers };
    headers.host = `${gwUpstreamHost}:${gwUpstreamPort}`;
    headers["x-dsh-mini-gateway"] = "1";
    const upstream = httpRequest(
      { hostname: "127.0.0.1", port: gwUpstreamPort, path: u, method: req.method, headers },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        // SSE / long-lived responses pipe through until the client disconnects.
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
    // proxied request instantly (socket hang). Track the RESPONSE side:
    // res 'close' fires when the client disconnects (or after finish).
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
  });
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
    url = `http://${ips[0]}:${cfg.gatewayPort}${APP_PREFIX}/?token=${encodeURIComponent(token)}`;
  } else if (port > 0) {
    url = `http://127.0.0.1:${port}${APP_PREFIX}/?token=${encodeURIComponent(token)}`;
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
// uploads (M2)
// ===========================================================================
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".heic"]);

function safeName(raw) {
  const base = String(raw || "file")
    .split(/[\\/]/)
    .pop()
    .replace(/[^\w.\- ()@[\]#&+~=]/g, "_")
    .slice(0, 120);
  return base || "file";
}

function mimeOf(fileName) {
  const ext = extname(fileName).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
    ".heic": "image/heic",
    ".pdf": "application/pdf",
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".json": "application/json",
    ".csv": "text/csv",
    ".zip": "application/zip",
  };
  return map[ext] || "application/octet-stream";
}

async function handleUpload(ctx, req, res, url) {
  const sessionId = String(url.searchParams.get("session") || "").trim();
  if (!sessionId) return sendJson(res, 400, { error: "session is required" });
  const cfg = loadConfig();
  const limit = cfg.maxUploadMb * 1048576;
  let buf;
  try {
    buf = await readBodyBuffer(req, limit);
  } catch (err) {
    return sendJson(res, err.status || 500, { error: String(err.message || err) });
  }
  if (!buf.length) return sendJson(res, 400, { error: "empty file" });
  const rawName = String(url.searchParams.get("name") || req.headers["x-file-name"] || "file.bin");
  const name = safeName(rawName);
  const dir = join(UPLOADS_ROOT, sessionId);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let finalName = `${stamp}_${name}`;
  let path = join(dir, finalName);
  let i = 1;
  while (existsSync(path)) {
    finalName = `${stamp}_${i}_${name}`;
    path = join(dir, finalName);
    i++;
  }
  writeFileSync(path, buf);
  watchSession(sessionId);
  return sendJson(res, 201, {
    path,
    name: finalName,
    originalName: name,
    size: buf.length,
    mime: mimeOf(name),
    session: sessionId,
    isImage: IMAGE_EXTS.has(extname(name).toLowerCase()),
  });
}

// validate + compose the followup message with attachment references
function composeMessage(sessionId, text, attachments) {
  const lines = [text];
  const imagePaths = [];
  if (Array.isArray(attachments) && attachments.length) {
    const root = normalize(UPLOADS_ROOT);
    lines.push("");
    lines.push("【附件】");
    for (const a of attachments) {
      const p = a && typeof a.path === "string" ? a.path : "";
      if (!p) continue;
      const np = normalize(p);
      if (!np.startsWith(root) || !np.startsWith(normalize(join(root, sessionId)))) continue;
      lines.push(`- ${a.name || basename(np)}: ${np}`);
      if (IMAGE_EXTS.has(extname(np).toLowerCase())) imagePaths.push(np);
    }
    if (imagePaths.length) {
      lines.push("");
      lines.push("用户附带了图片文件。如需查看图片内容，请调用 view_image 工具（source 参数传图片的绝对路径）。");
    }
  }
  return lines.join("\n");
}

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

    // GET /models
    if (parts.length === 1 && parts[0] === "models" && method === "GET") {
      const catalog = await getModelCatalog(ctx);
      return sendJson(res, 200, catalog);
    }

    // POST /upload
    if (parts.length === 1 && parts[0] === "upload" && method === "POST") {
      return await handleUpload(ctx, req, res, url);
    }

    // GET /workspaces：手机端新建会话的工作区选择器数据源
    // （桌面 workspace 域 registry + 默认工作区 + 历史会话 cwd 去重兜底）
    if (parts.length === 1 && parts[0] === "workspaces" && method === "GET") {
      return sendJson(res, 200, await listWorkspaces(ctx));
    }

    // /threads
    if (parts[0] === "threads") {
      // POST /threads/new  (must precede :id parsing)
      if (parts.length === 2 && parts[1] === "new" && method === "POST") {
        const body = await readBody(req);
        let cwd;
        try {
          cwd = JSON.parse(body || "{}").cwd;
        } catch {
          /* ignore */
        }
        const agent = await newSession(ctx, cwd);
        return sendJson(res, 201, { id: agent.session.id, cwd: agent.session.meta?.cwd || null });
      }
      // GET /threads
      if (parts.length === 1 && method === "GET") {
        const threads = await listThreads(ctx);
        return sendJson(res, 200, { threads });
      }
      // /threads/:id/(history|stream|send|stop|model|attach)
      if (parts.length >= 3) {
        const sessionId = decodeURIComponent(parts[1]);
        const sub = parts[2];
        if (sub === "history" && method === "GET") {
          const hist = await getHistory(ctx, sessionId);
          if (!hist) return sendJson(res, 404, { error: "session not found" });
          return sendJson(res, 200, hist);
        }
        if (sub === "stream" && method === "GET") {
          return openStream(ctx, res, sessionId);
        }
        if (sub === "send" && method === "POST") {
          const body = await readBody(req);
          let parsed;
          try {
            parsed = JSON.parse(body || "{}");
          } catch {
            return sendJson(res, 400, { error: "invalid JSON" });
          }
          const text = String(parsed.text || "").trim();
          if (!text) return sendJson(res, 400, { error: "text is required" });
          const agent = await getOrAttach(ctx, sessionId);
          const fullText = composeMessage(sessionId, text, parsed.attachments);
          // Enqueue; do NOT await whenIdle — the open-ended SSE stream delivers
          // the response. DSH serializes turns on a single agent, so concurrent
          // phone/desktop followups are naturally ordered (last-writer-wins).
          agent.followup(
            createUserMessage({
              content: [{ type: "text", text: fullText }],
              source: { kind: "user" },
            }),
          );
          return sendJson(res, 202, { accepted: true, session: sessionId });
        }
        if (sub === "stop" && method === "POST") {
          const agents = ctx.get("agents");
          const agent = agents && agents.get ? agents.get(sessionId) : void 0;
          if (!agent) return sendJson(res, 404, { error: "session not live" });
          try {
            if (typeof agent.cancel === "function") agent.cancel({ kind: "user" });
            else if (agent.ctx && typeof agent.ctx.emit === "function")
              agent.ctx.emit("agent/turn-stopping", { id: sessionId, cause: { kind: "user" } });
            return sendJson(res, 200, { stopped: true });
          } catch (err) {
            return sendJson(res, 500, { error: String(err?.message || err) });
          }
        }
        if (sub === "model" && method === "GET") {
          const sel = currentSelectionFor(ctx, sessionId);
          if (!sel) return sendJson(res, 503, { error: "no model configured" });
          return sendJson(res, 200, {
            provider: sel.provider,
            model: sel.model,
            reasoningEffort: sel.reasoningEffort || null,
            source: sel.source,
          });
        }
        if (sub === "model" && method === "POST") {
          // M2: per-session model switch — mutate the caller-held selection
          // object when live (takes effect on the next request), always persist
          // so re-attach after host restart keeps the choice.
          const body = await readBody(req);
          let parsed;
          try {
            parsed = JSON.parse(body || "{}");
          } catch {
            return sendJson(res, 400, { error: "invalid JSON" });
          }
          const provider = String(parsed.provider || "").trim();
          const model = String(parsed.model || "").trim();
          if (!provider || !model) {
            return sendJson(res, 400, { error: "provider and model are required" });
          }
          const effort = parsed.reasoningEffort ? String(parsed.reasoningEffort) : undefined;
          const next = { provider, model, reasoningEffort: effort };
          setStoredSelection(sessionId, next);
          const sel = liveSelections.get(sessionId);
          if (sel) sel.current = { provider, model, reasoningEffort: effort };
          watchSession(sessionId);
          return sendJson(res, 200, {
            ok: true,
            provider,
            model,
            reasoningEffort: effort || null,
            source: "phone",
          });
        }
        if (sub === "attach" && method === "POST") {
          const agent = await getOrAttach(ctx, sessionId);
          const sel = currentSelectionFor(ctx, sessionId);
          return sendJson(res, 200, {
            id: agent.session.id,
            live: true,
            cwd: agent.session.meta?.cwd || null,
            model: sel ? { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || null } : null,
          });
        }
      }
    }

    return sendJson(res, 404, { error: "not found: " + pathname });
  } catch (err) {
    const status = err.status || 500;
    console.error("[dsh-mini] " + method + " " + pathname + " -> " + status + ": " + (err.message || err));
    if (!res.headersSent) sendJson(res, status, { error: err.message || "internal error" });
  }
}

// SSE subscriber registry: sessionId -> Set<ServerResponse>
const subscribers = new Map();

function openStream(ctx, res, sessionId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  watchSession(sessionId);
  sseSend(res, "status", { status: "connected", session: sessionId });
  // meta: current title + model for the badge bar
  const sessions = ctx.get("sessions");
  const session = sessions && sessions.get ? sessions.get(sessionId) : null;
  if (session) {
    let title = "";
    try {
      const st = ctx.get("sessionTitle");
      const snap = st && st.get ? st.get(session) : null;
      if (snap && snap.title) title = snap.title;
    } catch {
      /* ignore */
    }
    const sel = currentSelectionFor(ctx, sessionId);
    sseSend(res, "meta", {
      session: sessionId,
      title: title || shortId(sessionId),
      model: sel ? { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || null } : null,
    });
  }
  if (!subscribers.has(sessionId)) subscribers.set(sessionId, new Set());
  const set = subscribers.get(sessionId);
  set.add(res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 25000);
  res.on("close", () => {
    clearInterval(ping);
    set.delete(res);
    if (set.size === 0) subscribers.delete(sessionId);
  });
}

// SSE subscriber registry was declared above openStream.
// ===========================================================================
// static file serving for the phone UI
// ===========================================================================
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function dispatchStatic(req, res, pathname) {
  let rel = pathname.slice(APP_PREFIX.length) || "/";
  if (rel === "/") rel = "/index.html";
  const safe = normalize(rel).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, "forbidden");
  }
  let data;
  try {
    data = readFileSync(filePath);
  } catch {
    return sendText(res, 404, "not found");
  }
  const type = MIME[extname(filePath).toLowerCase()] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
  res.end(data);
}

// ===========================================================================
// plugin entry
// ===========================================================================
function apply(ctx) {
  ensureToken();
  loadConfig();

  // 1) Global session-event listener -> fan out to phone SSE subscribers and
  //    mirror into watched-session buffers (host restart freezes session.events
  //    at the rehydration boundary, so history merges store + live mirror).
  ctx.effect(() => {
    const dispose = ctx.on("session/event", (session, event) => {
      const sessionId = session?.id;
      if (typeof sessionId !== "string") return;
      const norm = normalizeEvent(event);
      if (norm) {
        bufferPush(sessionId, event, norm);
        const set = subscribers.get(sessionId);
        if (set && set.size > 0) {
          for (const res of set) {
            try {
              sseSend(res, "step", norm);
            } catch {
              set.delete(res);
            }
          }
        }
      }
    });
    return () => {
      try {
        dispose();
      } catch {
        /* ignore */
      }
    };
  }, "dsh-mini: session/event fan-out");

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
          dispatchStatic(req, res, p);
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
