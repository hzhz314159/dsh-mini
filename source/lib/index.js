// @deepseek-ai/dsh-mini
// DSH Mini — phone bridge for DeepSeek Harness Desktop (Codex-Mini style).
//
// Runs INSIDE the DSH webServer as a Cordis plugin. A phone browser / app talks
// to this plugin over HTTP; the plugin drives real DSH agent sessions and
// streams their live events back. Every session is a real DSH session on the
// computer — the phone is just one remote participant, so the desktop and the
// phone are BIDIRECTIONALLY controllable and see the same event stream.
//
// API surface verified against the user's installed DSH (v0.3.5, rc.6) source:
//   ctx.webServer.register({ kind: 'prefix'|'exact', path, handler })   (dsh-file-changes, dsh-better-sidebar)
//   ctx.on('session/event', (session, event) => {})                      (global listener; session.id, event.seq/type/data)
//   ctx.agents.create/resume/get/list                                     (dsh-agent)
//   ctx.sessions.get(id).events | .header                                 (dsh-better-sidebar)
//   ctx.agentDefaultModel.currentSelection() -> {provider, model, reasoningEffort?}
//   ctx.sessionPersistence.list() -> headers[]                           (openclaw-dsh-bridge)
//   agent.followup(createUserMessage({content, source:{kind:'user'}}))    (cookbook)
//   agent.whenIdle() / agent.cancel({kind:'user'}) / agent.dispose()      (dsh-agent runtime-types)
//   event types: assistant/chunk (chunk.type: 'text-delta'|'reasoning-delta'),
//               assistant/message, tool/call, tool/result, turn/start, turn/end
//
// Remediation note: this plugin intentionally uses the OFFICIAL event feed
// (ctx.on('session/event')) rather than the older per-agent `agent.session.events`
// iterator — the global listener is what ships in first-party plugins and it
// naturally captures BOTH phone- and desktop-originated activity.

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize, extname, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import { installModelSelection } from "@deepseek-ai/dsh-agent";

const name = "@deepseek-ai/dsh-mini";
const inject = ["webServer", "agents", "sessions", "agentDefaultModel", "sessionPersistence"];

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

const MAX_BODY_BYTES = Number(process.env.DSH_MINI_MAX_BODY || 8 * 1024 * 1024);

// ---------------------------------------------------------------------------
// SSE subscriber registry: sessionId -> Set<ServerResponse>
// ---------------------------------------------------------------------------
const subscribers = new Map();

// ===========================================================================
// utilities
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

function effectiveToken() {
  if (process.env.DSH_MINI_TOKEN) return process.env.DSH_MINI_TOKEN;
  const f = join(MINI_HOME, "token.txt");
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
  if (process.env.DSH_MINI_TOKEN) return process.env.DSH_MINI_TOKEN;
  const f = join(MINI_HOME, "token.txt");
  if (existsSync(f)) {
    try {
      return readFileSync(f, "utf8").trim();
    } catch {
      /* fall through */
    }
  }
  mkdirSync(MINI_HOME, { recursive: true });
  const t = randomUUID().replace(/-/g, "");
  writeFileSync(f, t, "utf8");
  return t;
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

// 鉴权：回环地址免 token；非回环需 Bearer / x-dsh-mini-token / ?token= 匹配 effectiveToken。
// （EventSource 不能设请求头，LAN 手机走 ?token= 传参。）
function assertAuth(req, res, url) {
  if (isLoopback(req)) return true;
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

// ===========================================================================
// model selection
// ===========================================================================
// Returns { provider, model, reasoningEffort? } from ctx.agentDefaultModel,
// tolerant of both the service-with-method and the bare-selection shapes.
function resolveSelection(ctx) {
  const svc = ctx.get("agentDefaultModel");
  if (!svc) return null;
  if (typeof svc.currentSelection === "function") {
    const sel = svc.currentSelection();
    if (sel && sel.provider && sel.model) {
      return { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort };
    }
  }
  if (typeof svc === "object" && svc.provider && svc.model) {
    return { provider: svc.provider, model: svc.model, reasoningEffort: svc.reasoningEffort };
  }
  if (typeof svc === "string") {
    const [provider, ...rest] = svc.split("/");
    return { provider, model: rest.join("/") || provider };
  }
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
      const blocks = event.data?.message?.content || [];
      const text = blocks
        .filter((b) => b && b.type === "text")
        .map((b) => b.text || "")
        .join("");
      return { seq, type: "assistant", text, committed: true };
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
    case "turn/end":
      return { seq, type: "status", status: "turn-end", reason: event.data?.reason };
    default:
      return null;
  }
}

// ===========================================================================
// session driving (every session is a real DSH session on the computer)
// ===========================================================================
async function getOrAttach(ctx, sessionId) {
  const agents = ctx.get("agents");
  if (!agents) throw httpError(503, "DSH agents service unavailable");
  const live = agents.get ? agents.get(sessionId) : void 0;
  if (live !== void 0) return live;
  const selection = resolveSelection(ctx);
  if (!selection) throw httpError(503, "no model configured (set a default model in DSH)");
  const persistence = ctx.get("sessionPersistence");
  if (persistence && persistence.list) {
    const stored = (await persistence.list()).find((h) => h && h.id === sessionId);
    if (stored) {
      const { agent } = await agents.resume({
        resumeSessionId: sessionId,
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          reasoningEffort: selection.reasoningEffort,
        },
        setup: (agentCtx) => {
          installModelSelection(agentCtx, { current: selection, assembled: void 0 });
        },
      });
      await agent.whenIdle();
      return agent;
    }
  }
  throw httpError(404, "session not found: " + sessionId);
}

async function newSession(ctx, cwd) {
  const agents = ctx.get("agents");
  if (!agents) throw httpError(503, "DSH agents service unavailable");
  const selection = resolveSelection(ctx);
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
  const { agent } = await agents.create({
    sessionId: SessionId("dsh-mini-" + randomUUID()),
    meta: { cwd: workdir },
    agentOptions: {
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: selection.reasoningEffort,
    },
    setup: (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: void 0 });
    },
  });
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
  if (persistence && persistence.list) {
    try {
      const headers = await persistence.list();
      for (const h of headers) {
        const id = h && h.id;
        if (!id) continue;
        // 标题字段兼容：DSH 真实会话标题在 summary.title（见官方 dsh-session-manager
        // client.js: title = summary && summary.title ? summary.title : id）。
        // 已加载会话用实时 header 最权威；其余按 summary.title > title > name 兜底。
        const live = agents && agents.get ? agents.get(id) : void 0;
        const sessHeader = sessions && sessions.get ? (sessions.get(id) || {}).header : null;
        const summary = h.summary || (h.header && h.header.summary) || null;
        const title =
          (sessHeader && (sessHeader.title || sessHeader.name)) ||
          h.title ||
          (summary && (summary.title || summary.name)) ||
          h.name ||
          shortId(id);
        out.push({
          id,
          title,
          cwd: h.cwd || (h.header && h.header.cwd) || (sessHeader && sessHeader.cwd) || null,
          model: h.model || (h.header && h.header.model) || (sessHeader && sessHeader.model) || null,
          updatedAt: h.updatedAt || h.updated || (sessHeader && sessHeader.updatedAt) || null,
          live: Boolean(live),
        });
      }
    } catch (err) {
      console.error("[dsh-mini] listThreads error: " + String(err?.message || err));
    }
  }
  return out.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

async function getHistory(ctx, sessionId) {
  const sessions = ctx.get("sessions");
  const session = sessions && sessions.get ? sessions.get(sessionId) : null;
  if (!session) return null;
  const events = session.events || [];
  const steps = [];
  for (const event of events) {
    const norm = normalizeEvent(event);
    if (norm) steps.push(norm);
  }
  const header = session.header || {};
  return {
    id: sessionId,
    title: header.title || header.name || sessionId,
    cwd: header.cwd || null,
    model: header.model || null,
    reasoningEffort: header.reasoningEffort || null,
    steps,
  };
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
      // /threads/:id/(history|stream|send|stop|model)
      if (parts.length >= 3) {
        const sessionId = decodeURIComponent(parts[1]);
        const sub = parts[2];
        if (sub === "history" && method === "GET") {
          const hist = await getHistory(ctx, sessionId);
          if (!hist) return sendJson(res, 404, { error: "session not found" });
          return sendJson(res, 200, hist);
        }
        if (sub === "stream" && method === "GET") {
          return openStream(res, sessionId);
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
          // Enqueue; do NOT await whenIdle — the open-ended SSE stream delivers
          // the response. DSH serializes turns on a single agent, so concurrent
          // phone/desktop followups are naturally ordered (last-writer-wins).
          agent.followup(
            createUserMessage({
              content: [{ type: "text", text }],
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
          // 当前模型信息（GPT Mini 同款徽章数据源；切换留待 M2）
          const sel = resolveSelection(ctx);
          if (!sel) return sendJson(res, 503, { error: "no model configured" });
          return sendJson(res, 200, { provider: sel.provider, model: sel.model, reasoningEffort: sel.reasoningEffort || null });
        }
        if (sub === "model" && method === "POST") {
          // M2: model switching (placeholder — returns not-implemented until wired)
          return sendJson(res, 501, { error: "model switching lands in M2" });
        }
      }
    }

    // GET /balance  (M3 — placeholder)
    if (parts.length === 1 && parts[0] === "balance" && method === "GET") {
      return sendJson(res, 200, { balance: null, note: "balance lands in M3" });
    }

    return sendJson(res, 404, { error: "not found: " + pathname });
  } catch (err) {
    const status = err.status || 500;
    console.error("[dsh-mini] " + method + " " + pathname + " -> " + status + ": " + (err.message || err));
    if (!res.headersSent) sendJson(res, status, { error: err.message || "internal error" });
  }
}

function openStream(res, sessionId) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*",
  });
  sseSend(res, "status", { status: "connected", session: sessionId });
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
  // 1) Global session-event listener -> fan out to phone SSE subscribers.
  //    Host-level ctx.on('session/event') receives events for ALL sessions
  //    (proven in dsh-better-sidebar / dsh-user-approval / dsh-tools), which is
  //    exactly what gives us the bidirectional desktop<->phone stream.
  const disposeListener = ctx.on("session/event", (session, event) => {
    const sessionId = session?.id;
    if (typeof sessionId !== "string") return;
    const set = subscribers.get(sessionId);
    if (!set || set.size === 0) return;
    const norm = normalizeEvent(event);
    if (!norm) return;
    for (const res of set) {
      try {
        sseSend(res, "step", norm);
      } catch {
        set.delete(res);
      }
    }
  });
  ctx.effect(() => disposeListener, "dsh-mini: session/event fan-out");

  // 2) HTTP routes — ONE prefix route, internal dispatch. A single prefix avoids
  //    ambiguity when /dsh-mini/api/* and /dsh-mini/* would both match.
  const disposeHttp = ctx.webServer.register({
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
  });
  ctx.effect(() => disposeHttp, "dsh-mini: http routes");

  // 3) Token bootstrap + startup log.
  const token = ensureToken();
  console.log(`[dsh-mini] v${PLUGIN_VERSION} mounted at ${APP_PREFIX}/ (api: ${API_PREFIX}/)`);
  console.log(`[dsh-mini] bridge token (share with the phone app): ${token}`);
  console.log(`[dsh-mini] loopback connections are token-free; LAN phone needs the token above.`);
}

export { name, inject, apply };
