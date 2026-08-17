// @deepseek-ai/dsh-mini — gui-api.js
// 手机端 v3 GUI 的 RPC 实现（官方 DSH 前端契约 1:1 自建，不依赖官方 apiproxy）。
// Wire 协议（与官方一致）：
//   POST /api/<method>  body: { type:'client-request', rpcId, method, payload }
//   -> 200 { type:'server-response', rpcId, result:{ ok:true, value } }
//   -> 200 { type:'server-response', rpcId, result:{ ok:false, error:{ code, message, details? } } }
//   carrier 层错误（坏 JSON / 未知 method）用 HTTP 400。
// 所有方法直通 ctx 服务（sessions/subagents/workspace/settings/credentials/agentPresets/goals/
// skills/llm/agentDefaultModel/sessionQuery/directoryPicker），返回形状对齐官方 wire schema。
// 本模块不注册任何效果，纯函数库，由 index.js 的网关 handler 调用。

const PREFIX = "@deepseek-ai/dsh-mini";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { installModelSelection } from "@deepseek-ai/dsh-agent";
import { findSessionFile, foldLogEvents, readAllLogEvents, dshHome } from "./zstd-log.js";

class RpcError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    this.details = details !== undefined ? details : {};
  }
}

const dispatch = {}; // method -> async (ctx, payload) => value

function method(name, handler) {
  dispatch[name] = handler;
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function req(payload, key, def) {
  if (payload == null) payload = {};
  return payload[key] !== undefined ? payload[key] : def;
}

function sessionSvc(ctx) {
  const s = ctx.get("sessions");
  if (!s) throw new RpcError("internal", "sessions service not mounted");
  return s;
}
function requireSession(ctx, sessionId) {
  const sessions = sessionSvc(ctx);
  const session = sessions.get(sessionId);
  if (!session) {
    throw new RpcError("session-not-found", `session "${sessionId}" not found`, { sessionId });
  }
  return session;
}
function requireSvc(ctx, name) {
  const s = ctx.get(name);
  if (!s) throw new RpcError("internal", `${name} service not mounted`);
  return s;
}

// ---------------------------------------------------------------------------
// host.describe —— 连接握手，前端打开即调
// ---------------------------------------------------------------------------
method("host.describe", async (ctx, payload) => {
  const ws = ctx.get("webServer");
  const defaultModel = ctx.get("agentDefaultModel");
  const sel =
    defaultModel && typeof defaultModel.currentSelection === "function"
      ? defaultModel.currentSelection()
      : null;
  const attached = countAttached(ctx);
  return {
    version: "0.0.1",
    cwd: process.env.DSH_SESSION_CWD || process.cwd() || "",
    provider: sel ? sel.provider : undefined,
    model: sel ? sel.model : undefined,
    attachedSessions: attached,
    canOpenPath: false,
  };
});
function countAttached(ctx) {
  try {
    const s = ctx.get("sessions");
    if (s && typeof s.list === "function") {
      const l = s.list();
      return Array.isArray(l) ? l.length : 0;
    }
  } catch {
    /* ignore */
  }
  return 0;
}

// ---------------------------------------------------------------------------
// session.*
// ---------------------------------------------------------------------------
method("session.list", async (ctx, payload) => {
  // 与官方 listVisibleSessionSummaries 同构：attached(内存) + cold(持久化) 合并，updatedAt 倒序
  const items = [];
  const seen = new Set();
  const sessions = sessionSvc(ctx);
  const agents = ctx.get("agents");
  let memList = [];
  try {
    memList = sessions.list() || [];
  } catch { /* ignore */ }
  for (const s of memList) {
    const id = s.id || s.sessionId;
    if (!id) continue;
    seen.add(id);
    items.push(sessionSummaryFrom(ctx, s, agents));
  }
  // cold：sessionPersistence.list() 摘要
  const persistence = ctx.get("sessionPersistence");
  let metas = [];
  try {
    if (persistence && typeof persistence.list === "function") {
      const r = await persistence.list();
      if (Array.isArray(r)) metas = r;
    }
  } catch { /* ignore */ }
  for (const meta of metas) {
    const id = meta && meta.id;
    if (!id || seen.has(id)) continue;
    // 官方过滤：cwd === undefined 的 cold session 跳过
    if (meta.cwd === undefined) continue;
    const summary = await coldSummary(ctx, id, meta);
    if (!summary) continue;
    seen.add(id);
    items.push(summary);
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return { items };
});
async function coldSummary(ctx, sessionId, meta) {
  // meta = persistence.list() 返回的 { id, cwd, createdAt, parentSession, origin, agentPreset, ... }
  const cwd = meta?.cwd;
  // 先尝试官方 sessionProjectionCache（cold session 专用）
  let projections;
  try {
    const cache = ctx.get("sessionProjectionCache");
    if (cache && typeof cache.cachedSnapshot === "function") {
      const block = cache.cachedSnapshot(meta);
      if (block && block.values && Object.keys(block.values).length > 0) projections = block;
    }
  } catch { /* ignore */ }
  // 降级：foldLogEvents 提取 title + updatedAt
  let fold;
  if (!projections) {
    const file = findSessionFile(dshHome(), sessionId);
    if (!file) return null;
    try {
      fold = foldLogEvents(file);
    } catch {
      return null;
    }
    const values = {};
    if (fold.title) values.title = { title: fold.title };
    projections = { asOfSeq: fold.events.length ? fold.events[fold.events.length - 1].seq : -1, values };
  }
  // updatedAt: 官方用 Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
  let updatedAt = 0;
  try {
    updatedAt = Math.max(meta?.createdAt || 0, fold?.updatedAt || 0);
  } catch { updatedAt = Date.now(); }
  const fields = {};
  if (cwd !== undefined) fields.cwd = cwd;
  if (meta?.parentSession !== undefined) fields.parentSessionId = meta.parentSession;
  if (meta?.origin !== undefined) fields.origin = meta.origin;
  if (meta?.agentPreset !== undefined) fields.agentPreset = meta.agentPreset;
  return {
    sessionId,
    updatedAt,
    running: false,
    blank: fold ? !fold.events.length : false,
    ...fields,
    projections,
  };
}
function sessionSummaryFrom(ctx, s, agents) {
  const id = s.id || s.sessionId;
  const header = s.header || {};
  // running: 官方用 ctx.agents.get(id)?.status === 'running'
  let running = false;
  try {
    if (agents && typeof agents.get === "function") {
      const agent = agents.get(id);
      running = agent?.status === "running";
    }
  } catch { /* ignore */ }
  // updatedAt: 官方用 Math.max(header.createdAt, metadata?.lastPromptAt ?? 0)
  let updatedAt = 0;
  try {
    updatedAt = Math.max(header.createdAt || 0, lastPromptAt(s));
  } catch { updatedAt = Date.now(); }
  // blank: 无事件且不在运行
  let blank = !running;
  try {
    const ev = s.events;
    if (Array.isArray(ev) && ev.length > 0) blank = false;
  } catch { /* ignore */ }
  // sessionListFields: cwd/parentSessionId/origin/agentPreset 从 header
  const fields = {};
  if (header.cwd !== undefined) fields.cwd = header.cwd;
  if (header.parentSession !== undefined) fields.parentSessionId = header.parentSession;
  if (header.origin !== undefined) fields.origin = header.origin;
  if (header.agentPreset !== undefined) fields.agentPreset = header.agentPreset;
  // projections: 官方用 ctx.get('sessionProjections')?.snapshot(session)
  const projections = collectProjections(ctx, s, header);
  return {
    sessionId: id,
    updatedAt,
    running,
    blank,
    ...fields,
    projections,
  };
}
// 从事件流中提取 lastPromptAt（最后一个 user/message 的时间戳）
function lastPromptAt(s) {
  try {
    const ev = s.events;
    if (!Array.isArray(ev)) return 0;
    for (let i = ev.length - 1; i >= 0; i--) {
      const e = ev[i];
      if (e && e.type === "user/message" && typeof e.time === "number") return e.time;
    }
  } catch { /* ignore */ }
  return 0;
}
// 投影：优先用 ctx.get('sessionProjections')?.snapshot(session)，降级 foldLogEvents
function collectProjections(ctx, s, header) {
  // 尝试官方 sessionProjections 服务
  try {
    const projSvc = ctx.get("sessionProjections");
    if (projSvc && typeof projSvc.snapshot === "function") {
      const block = projSvc.snapshot(s);
      if (block && block.values && Object.keys(block.values).length > 0) return block;
    }
  } catch { /* ignore */ }
  // 降级：从事件流提取 title
  const values = {};
  try {
    const ev = s.events;
    if (Array.isArray(ev)) {
      for (const e of ev) {
        if (e && e.type === "session/title" && e.data?.title) {
          values.title = { title: e.data.title };
          break;
        }
      }
    }
  } catch { /* ignore */ }
  // 也尝试从 attributes/projection 属性
  try {
    if (typeof s.projection == "object" && s.projection !== null) {
      for (const k of Object.keys(s.projection)) if (!(k in values)) values[k] = s.projection[k];
    }
  } catch { /* ignore */ }
  return { asOfSeq: lastSeqOf(s), values };
}
function countEvents(s) {
  try {
    const ev = s.events;
    return Array.isArray(ev) ? ev.length : 0;
  } catch {
    return 0;
  }
}
// 投影 baseline：从 ctx.get('sessionProjections') 或 fold 提取（对齐官方 14 键的常见子集）
function collectProjectionsOld(s) {
  const values = {};
  try {
    if (typeof s.projection == "object" && s.projection !== null) {
      for (const k of Object.keys(s.projection)) values[k] = s.projection[k];
    }
  } catch { /* ignore */ }
  try {
    if (s.attributes && typeof s.attributes === "object") {
      for (const k of Object.keys(s.attributes)) {
        if (!(k in values)) values[k] = s.attributes[k];
      }
    }
  } catch { /* ignore */ }
  return { asOfSeq: lastSeqOf(s), values };
}
function lastSeqOf(s) {
  try {
    const ev = s.events;
    if (Array.isArray(ev) && ev.length) {
      const last = ev[ev.length - 1];
      if (last && typeof last.seq === "number") return last.seq;
    }
  } catch { /* ignore */ }
  return -1;
}

method("session.search", async (ctx, payload) => {
  // 官方 session-query 索引可能未启用（openAt never）。降级：内存线性匹配
  const q = String(req(payload, "query", "")).trim();
  const sessions = sessionSvc(ctx);
  const list = safeList(sessions);
  const items = [];
  const ql = q.toLowerCase();
  for (const s of list) {
    const hay = (String(s.id || "") + " " + String(s.cwd || "") + " " + titleOf(s)).toLowerCase();
    if (ql && hay.includes(ql)) {
      items.push({ sessionId: s.id || s.sessionId, snippet: titleOf(s) || s.id || "" });
      if (items.length >= 50) break;
    }
  }
  return { items, hasMore: false };
});
function safeList(sessions) {
  try {
    const l = sessions.list();
    return Array.isArray(l) ? l : [];
  } catch {
    return [];
  }
}
function titleOf(s) {
  try {
    const p = s.projection || s.attributes || {};
    return (p.title && p.title.title) || p.title || "";
  } catch {
    return "";
  }
}

// 官方 ensureSession 对齐：live agent 直返；已持久化 → resume；否则 create（agent+session 一体）
// 返回 { agent } 或抛 RpcError
async function ensureSession(ctx, sessionId, cwd, presetId) {
  const agents = ctx.get("agents");
  if (!agents || typeof agents.get !== "function" || typeof agents.resume !== "function" || typeof agents.create !== "function") {
    throw new RpcError("internal", "agents service not mounted");
  }
  const live = agents.get(sessionId);
  if (live) return { agent: live };
  const selection = resolveSelectionById(ctx, sessionId);
  if (!selection || !selection.provider || !selection.model) {
    throw new RpcError("internal", "no model configured (set a default model in DSH)");
  }
  const sel = { current: { ...selection }, assembled: void 0 };
  const agentOptions = {
    provider: selection.provider,
    model: selection.model,
    reasoningEffort: selection.reasoningEffort,
  };
  const setup = (agentCtx) => {
    installModelSelection(agentCtx, sel);
  };
  const file = sessionId ? await findSessionFile(dshHome(), sessionId) : undefined;
  if (file) {
    try {
      const created = await agents.resume({ resumeSessionId: sessionId, agentOptions, setup });
      if (created && created.agent) {
        sessionSelections.set(sessionId, sel.current);
        return { agent: created.agent };
      }
    } catch (e) {
      // resume 失败（如 live 冲突）：若 agent 已 live 则用之，否则继续 create 兜底
      const again = agents.get(sessionId);
      if (again) return { agent: again };
      throw new RpcError("internal", "agent resume failed: " + e.message);
    }
  }
  try {
    const created = await agents.create({
      sessionId,
      ...(cwd ? { meta: { cwd } } : {}),
      ...(presetId ? { meta: { cwd, agentPreset: presetId } } : {}),
      agentOptions,
      setup,
    });
    if (created && created.agent) {
      sessionSelections.set(sessionId, sel.current);
      return { agent: created.agent };
    }
  } catch (e) {
    const again = agents.get(sessionId);
    if (again) return { agent: again };
    throw new RpcError("internal", "agent create failed: " + e.message);
  }
  throw new RpcError("internal", "agent unavailable");
}

// 按会话 id 解析模型选择（无需 Session 对象：会话可能尚未在 store）
function resolveSelectionById(ctx, sessionId) {
  let current = null;
  try {
    const sessions = ctx.get("sessions");
    const s = sessions && typeof sessions.get === "function" ? sessions.get(sessionId) : void 0;
    current = s && (s.modelSelection || (s.attributes && s.attributes.modelSelection)) || null;
  } catch { /* ignore */ }
  if (!current && sessionSelections.has(sessionId)) {
    current = sessionSelections.get(sessionId);
  }
  if (!current) {
    const dm = ctx.get("agentDefaultModel");
    if (dm && typeof dm.currentSelection === "function") {
      const d = dm.currentSelection();
      if (d && !Array.isArray(d)) {
        current = { provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort };
      }
    }
  }
  return current;
}

method("session.create", async (ctx, payload) => {
  const cwd = payload.cwd || (await resolveWorkspaceCwd(ctx, payload.workspaceId)) || undefined;
  let sessionId = payload.sessionId || "session-" + randomUUID();
  let agent;
  try {
    const r = await ensureSession(ctx, sessionId, cwd, payload.agentPreset);
    agent = r.agent;
    sessionId = agent.session ? agent.session.id : agent.id;
  } catch (e) {
    if (e instanceof RpcError) throw e;
    throw new RpcError("internal", "session.create failed: " + e.message);
  }
  const preset = agent.session && (agent.session.header && agent.session.header.agentPreset);
  return {
    sessionId,
    ...(preset ? { agentPreset: preset } : {}),
  };
});
async function resolveWorkspaceCwd(ctx, workspaceId) {
  if (!workspaceId) return undefined;
  try {
    const w = requireSvc(ctx, "workspaceRegistry");
    const list = w.list ? w.list() : [];
    if (Array.isArray(list)) {
      const hit = list.find((x) => x.workspaceId === workspaceId || x.id === workspaceId);
      if (hit) return hit.path;
    }
  } catch { /* ignore */ }
  return undefined;
}

method("session.rename", async (ctx, payload) => {
  const session = requireSession(ctx, payload.sessionId);
  const titleSvc = ctx.get("sessionTitle");
  if (titleSvc) {
    try {
      const r = await titleSvc.set(session, payload.title);
      const seq = (r && typeof r === "object" && typeof r.seq === "number") ? r.seq : lastSeqOf(session);
      return { title: payload.title, seq };
    } catch (e) {
      throw new RpcError("internal", "session.rename failed: " + e.message);
    }
  }
  // 降级：直接写 attributes.title + title 投影
  try {
    session.title = payload.title;
    const ev = session.events;
    const seq = Array.isArray(ev) && ev.length ? ev[ev.length - 1].seq : 0;
    return { title: payload.title, seq };
  } catch (e) {
    throw new RpcError("internal", "session.rename failed: " + e.message);
  }
});

method("session.fork", async (ctx, payload) => {
  const sessions = sessionSvc(ctx);
  const parent = requireSession(ctx, payload.sessionId);
  try {
    const meta = {};
    if (parent.cwd) meta.cwd = parent.cwd;
    if (parent.parentSessionId) meta.parentSession = parent.parentSessionId;
    const child = sessions.create(undefined, { meta });
    return { sessionId: child.id || child.sessionId };
  } catch (e) {
    throw new RpcError("internal", "session.fork failed: " + e.message);
  }
});

method("session.history", async (ctx, payload) => {
  const sessions = sessionSvc(ctx);
  const session = sessions.get(payload.sessionId);
  const file = findSessionFile(dshHome(), payload.sessionId);
  if (!session && !file) {
    throw new RpcError("session-not-found", `session "${payload.sessionId}" not found`, { sessionId: payload.sessionId });
  }
  const beforeSeq = payload.beforeSeq != null ? payload.beforeSeq : Infinity;
  const maxMessages = payload.maxMessages != null ? payload.maxMessages : 100;
  // 数据源 1：持久化日志原文（完整事件流，含 assistant/chunk 等全部类型）
  let events = [];
  if (file) {
    try {
      events = readAllLogEvents(file);
    } catch { /* ignore */ }
  }
  // 数据源 2：live 内存事件补日志尾部（rehydration 边界后的新事件，按 seq 去重）
  if (session) {
    const liveEvs = collectEvents(session);
    const maxLogSeq = events.length && typeof events[events.length - 1].seq === "number"
      ? events[events.length - 1].seq
      : -1;
    const fresh = liveEvs.filter((e) => typeof e.seq === "number" && e.seq > maxLogSeq);
    events = events.concat(fresh);
  }
  // 只保留事件（跳过 session metadata 头行）
  const evs = events.filter((e) => e && typeof e === "object" && typeof e.type === "string" && typeof e.seq === "number");
  // 分页：从尾部向前直到满 maxMessages 个消息事件
  const tail = [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const ev = evs[i];
    if (ev.seq >= beforeSeq) continue;
    tail.push(ev);
  }
  tail.reverse();
  const result = [];
  let messages = 0;
  let lastKept = -1;
  for (const ev of tail) {
    const isMsg = /^(user|assistant)\/message$/.test(ev.type);
    if (isMsg && ++messages > maxMessages) break;
    result.push({ event: normalizeEvent(ev), view: toolViewFor(ev) });
    lastKept = ev.seq;
  }
  const hasMore = result.length < tail.length && (tail.length === 0 || lastKept > -1);
  return {
    events: result,
    hasMore,
    projections: session ? collectProjections(ctx, session, session.header || {}) : await coldProjections(ctx, payload.sessionId),
  };
});
async function coldProjections(ctx, sessionId) {
  const file = findSessionFile(dshHome(), sessionId);
  if (!file) return undefined;
  try {
    const fold = foldLogEvents(file);
    const values = {};
    if (fold.title) values.title = { title: fold.title };
    const seq = fold.events.length && typeof fold.events[fold.events.length - 1].seq === "number"
      ? fold.events[fold.events.length - 1].seq
      : -1;
    return { asOfSeq: seq, values };
  } catch {
    return undefined;
  }
}
function collectEvents(session) {
  try {
    const ev = session.events;
    return Array.isArray(ev) ? ev : [];
  } catch {
    return [];
  }
}
function normalizeEvent(ev) {
  const out = { type: ev.type, seq: ev.seq, time: ev.time, data: ev.data };
  if (ev.sourceEventSeqs) out.sourceEventSeqs = ev.sourceEventSeqs;
  if (ev.surfaceOp) out.surfaceOp = ev.surfaceOp;
  if (ev.ignorable === true) out.ignorable = true;
  return out;
}
function toolViewFor(ev) {
  const data = ev.data;
  if (!data || typeof data !== "object") return undefined;
  if (ev.type === "tool/call" || ev.type === "tool/result") {
    return { for: ev.type === "tool/call" ? "call" : "result", view: { card: data.card || data.tool || "tool" } };
  }
  return undefined;
}

method("session.models", async (ctx, payload) => {
  const session = requireSession(ctx, payload.sessionId);
  const catalog = await loadModelCatalog(ctx);
  const current = resolveCurrentSelection(ctx, session);
  return {
    current: current || { provider: "", model: "", reasoningEffort: undefined },
    routable: !!(current && current.provider && current.model),
    groups: catalog.groups,
    failures: catalog.failures,
  };
});

// 解析会话当前模型选择（优先级：会话级 → 内存选择 → 全局默认）
function resolveCurrentSelection(ctx, session) {
  const id = session.id || session.sessionId;
  let current = null;
  try {
    current = session.modelSelection || (session.attributes && session.attributes.modelSelection) || null;
  } catch { /* ignore */ }
  if (!current && sessionSelections.has(id)) {
    current = sessionSelections.get(id);
  }
  if (!current) {
    const dm = ctx.get("agentDefaultModel");
    if (dm && typeof dm.currentSelection === "function") {
      const d = dm.currentSelection();
      if (d && !Array.isArray(d)) {
        current = {
          provider: d.provider,
          model: d.model,
          reasoningEffort: d.reasoningEffort,
        };
      }
    }
  }
  return current;
}

async function loadModelCatalog(ctx) {
  try {
    const llm = requireSvc(ctx, "llm");
    if (typeof llm.listProviders !== "function") throw new Error("no listProviders");
    const providers = llm.listProviders();
    const groups = [];
    const failures = [];
    for (const p of providers || []) {
      const pid = p.id || p.provider;
      if (!pid) continue;
      let models = [];
      try {
        if (typeof llm.listModels === "function") {
          const ml = await llm.listModels(pid);
          const resolved = await Promise.all((ml || []).map(async (m) => {
            const base = {
              id: m.id || m.model,
              name: m.name || m.id || m.model,
              description: m.description,
              reasoning: m.reasoning,
            };
            // 补充 reasoning 元数据（官方 resolveModelInfo 提供 efforts/defaultEffort，
            // 前端模型弹窗的「推理等级」面板依赖它）
            if (!base.reasoning && typeof llm.resolveModelInfo === "function") {
              try {
                const info = await llm.resolveModelInfo(pid, base.id);
                if (info && info.reasoning) base.reasoning = info.reasoning;
              } catch { /* ignore */ }
            }
            return base;
          }));
          models = resolved;
        }
      } catch (e) {
        failures.push({ id: pid, name: p.name || pid, message: String(e.message || e) });
      }
      groups.push({ id: pid, name: p.name || pid, models });
    }
    return { groups, failures };
  } catch (e) {
    return { groups: [], failures: [{ id: "catalog", name: "模型目录", message: String(e.message || e) }] };
  }
}
let modelCatalogCache = null; // { at, data }
async function loadModelCatalogCached(ctx) {
  const now = Date.now();
  const ttl = 30000;
  if (modelCatalogCache && now - modelCatalogCache.at < ttl) return modelCatalogCache.data;
  const data = await loadModelCatalog(ctx);
  modelCatalogCache = { at: now, data };
  return data;
}

method("session.selectModel", async (ctx, payload) => {
  const session = requireSession(ctx, payload.sessionId);
  const selection = { provider: payload.provider, model: payload.model };
  if (payload.reasoningEffort) selection.reasoningEffort = payload.reasoningEffort;
  try {
    const llm = ctx.get("llm");
    if (llm && typeof llm.resolveCallConfig === "function") {
      await llm.resolveCallConfig(payload.provider, payload.model, { signal: undefined });
    }
  } catch (e) {
    if (e && (e.name === "AbortError")) throw e;
    // 校验失败不是致命：让 agent 层兜底
  }
  // 会话级选择：写入 session.attributes + 尝试挂会话模型选择
  try {
    session.modelSelection = selection;
    if (session.attributes) session.attributes.modelSelection = selection;
  } catch { /* ignore */ }
  installSessionSelection(ctx, session, selection);
  return { selected: selection };
});
// 会话模型选择：复用 installModelSelection 挂到会话 ctx（agent 装配时生效）
const sessionSelections = new Map(); // sessionId -> selection
function installSessionSelection(ctx, session, selection) {
  const id = session.id || session.sessionId;
  sessionSelections.set(id, selection);
  // 若会话已有 agent ctx，尝试装配
  try {
    const agents = ctx.get("agents");
    if (agents) {
      const ag = agents.get && agents.get(id);
      if (ag && ag.ctx && typeof ag.ctx === "object") {
        try {
          installModelSelection(ag.ctx, sessionSelections.get(id));
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

method("session.prompt", async (ctx, payload) => {
  const session = requireSession(ctx, payload.sessionId);
  const mode = payload.mode === "steer" ? "steer" : "queue";
  const content = payload.content || [];
  // 校验内容块形状（对齐 promptContentPartSchema）
  for (const part of content) {
    if (!part || typeof part !== "object" || typeof part.type !== "string") {
      throw new RpcError("bad-request", "prompt content part must be an object with a string type");
    }
    if (part.type === "text" && typeof part.text !== "string") {
      throw new RpcError("bad-request", "text part requires a string text");
    }
    if (part.type === "image" && typeof part.mediaType !== "string" && typeof part.data !== "string") {
      throw new RpcError("bad-request", "image part requires mediaType and data");
    }
  }
  const textPart = content.find((p) => p && p.type === "text" && typeof p.text === "string");
  if (!textPart) {
    throw new RpcError("bad-request", "prompt requires at least one text part");
  }
  // 与官方一致：createUserMessage 构造完整用户消息（含 source），不提前 append——
  // agent.followup(message) 内部负责入队/事件（user 消息事件由 agent 层发出，mux 全量转发）
  const message = createUserMessage({
    content,
    source: { kind: "user" },
  });
  // 官方 ensureSession 对齐：live agent 直用，否则 resume/create
  const { agent } = await ensureSession(ctx, session.id || session.sessionId, session.cwd, undefined);
  if (mode === "steer" && typeof agent.steer === "function") agent.steer(message);
  else agent.followup(message);
  return { accepted: true, command: undefined };
});

method("session.attachment", async (ctx, payload) => {
  // 附件回读：attachment 引用来自事件流图片 content block
  const session = requireSession(ctx, payload.sessionId);
  const attId = payload.attachmentId;
  const att = ctx.get("attachments");
  let data = null;
  let meta = null;
  try {
    if (att && typeof att.read === "function") {
      const r = await att.read(attId);
      if (r) {
        data = r.data ? r.data : r;
        meta = r.meta || r;
      }
    } else if (att && typeof att.get === "function") {
      const r = await att.get(attId);
      data = r && r.data ? r.data : r;
      meta = r;
    }
  } catch (e) {
    throw new RpcError("attachment-error", `attachment "${attId}" not found: ${e.message}`, { reason: String((e && e.message) || e) });
  }
  if (data == null) {
    throw new RpcError("attachment-error", `attachment "${attId}" not found`, { reason: "not found" });
  }
  return {
    attachment: {
      attachmentId: attId,
      mediaType: (meta && meta.mediaType) || "image/png",
      bytes: (meta && meta.bytes) || (typeof data === "string" ? data.length : 0),
      width: (meta && meta.width) || 0,
      height: (meta && meta.height) || 0,
      name: meta && meta.name,
    },
    data: typeof data === "string" ? data : Buffer.from(data).toString("base64"),
  };
});

method("session.updateQueue", async (ctx, payload) => {
  const session = requireSession(ctx, payload.sessionId);
  const action = payload.action;
  if (!action || typeof action.kind !== "string") {
    throw new RpcError("bad-request", "updateQueue requires action.kind");
  }
  const agents = ctx.get("agents");
  const agent = agents && agents.get(session.id || session.sessionId);
  if (!agent || typeof agent.updateQueue !== "function") {
    throw new RpcError("bad-request", "agent queue editing is unavailable for this session");
  }
  try {
    agent.updateQueue({ itemId: payload.itemId, action });
  } catch (e) {
    throw new RpcError("internal", "updateQueue failed: " + e.message);
  }
  return { accepted: true };
});

method("session.cancel", async (ctx, payload) => {
  const session = requireSession(ctx, payload.sessionId);
  const agents = ctx.get("agents");
  const agent = agents && agents.get(session.id || session.sessionId);
  if (agent && typeof agent.cancel === "function") {
    try {
      agent.cancel({ kind: "user" }, { keepInbox: true });
    } catch { /* ignore */ }
  }
  return { accepted: true };
});

// ---------------------------------------------------------------------------
// llm.*
// ---------------------------------------------------------------------------
method("llm.providers", async (ctx, payload) => {
  const llm = requireSvc(ctx, "llm");
  const registered =
    typeof llm.listProviders === "function" ? llm.listProviders() || [] : [];
  const active = new Set(registered.map((p) => p.id));
  const views = [];
  try {
    if (typeof llm.listConfigurableProviders === "function") {
      const directory = llm.listConfigurableProviders() || [];
      const declared = new Set(directory.map((e) => e.provider));
      for (const entry of directory) {
        views.push({
          provider: entry.provider,
          displayName: entry.displayName,
          settingsNs: entry.settingsNs,
          settingsPath: [...(entry.settingsPath || [])],
          active: active.has(entry.provider),
          ...(entry.declared === undefined ? {} : { declared: entry.declared }),
        });
      }
      for (const provider of registered) {
        if (declared.has(provider.id)) continue;
        views.push({
          provider: provider.id,
          displayName: provider.name || provider.id,
          settingsNs: "",
          settingsPath: [],
          active: true,
        });
      }
    }
  } catch { /* ignore */ }
  if (!views.length) {
    for (const p of registered) {
      views.push({
        provider: p.id || p.provider,
        displayName: p.name || p.displayName || p.id || p.provider,
        settingsNs: p.settingsNs || "",
        settingsPath: p.settingsPath || [],
        active: p.active !== false,
        declared: p.declared,
      });
    }
  }
  return { providers: views };
});

method("llm.models", async (ctx, payload) => {
  const catalog = await loadModelCatalogCached(ctx);
  return catalog;
});

method("llm.discoverModels", async (ctx, payload) => {
  // 写性质询（探测供应商模型）。降级：返回空（官方需要网络探测，手机端不常用）
  return { models: [] };
});

// ---------------------------------------------------------------------------
// workspace.*
// ---------------------------------------------------------------------------
function workspaceSvc(ctx) {
  return requireSvc(ctx, "workspaceRegistry");
}
function workspaceView(w) {
  return {
    workspaceId: w.workspaceId || w.id,
    path: w.path || "",
    title: w.title || "",
    sessionIds: w.sessionIds || [],
    createdAt: w.createdAt || "",
    updatedAt: w.updatedAt || "",
  };
}
method("workspace.list", async (ctx, payload) => {
  try {
    const w = workspaceSvc(ctx);
    const list = typeof w.list === "function" ? w.list() : [];
    const items = (Array.isArray(list) ? list : []).map(workspaceView);
    let archived = [];
    try {
      if (typeof w.archivedSessionIds === "function") archived = w.archivedSessionIds();
      else if (w.archivedSessionIds && Array.isArray(w.archivedSessionIds)) archived = w.archivedSessionIds;
    } catch { /* ignore */ }
    return { items, archivedSessionIds: archived };
  } catch (e) {
    if (e instanceof RpcError) throw e;
    return { items: [], archivedSessionIds: [] };
  }
});
method("workspace.create", async (ctx, payload) => {
  const w = workspaceSvc(ctx);
  try {
    const r = typeof w.create === "function" ? await w.create({ path: payload.path }) : w.create({ path: payload.path });
    return {
      workspace: workspaceView(r && r.workspace ? r.workspace : r),
      created: !!(r && r.created),
    };
  } catch (e) {
    throw new RpcError("internal", "workspace.create failed: " + e.message);
  }
});
method("workspace.rename", async (ctx, payload) => {
  const w = workspaceSvc(ctx);
  try {
    const r = await w.rename({ workspaceId: payload.workspaceId, title: payload.title });
    return { workspace: workspaceView(r && r.workspace ? r.workspace : r) };
  } catch (e) {
    throw new RpcError("internal", "workspace.rename failed: " + e.message);
  }
});
method("workspace.delete", async (ctx, payload) => {
  try {
    const w = workspaceSvc(ctx);
    if (typeof w.delete === "function") await w.delete({ workspaceId: payload.workspaceId });
  } catch (e) {
    throw new RpcError("internal", "workspace.delete failed: " + e.message);
  }
  return { deleted: true };
});
method("workspace.insertBefore", async (ctx, payload) => {
  const w = workspaceSvc(ctx);
  try {
    const r = await w.insertBefore({ workspaceId: payload.workspaceId, beforeWorkspaceId: payload.beforeWorkspaceId });
    const ids = (r && r.workspaceIds) || (Array.isArray(r) ? r : []);
    return { workspaceIds: ids };
  } catch (e) {
    throw new RpcError("internal", "workspace.insertBefore failed: " + e.message);
  }
});
method("workspace.insertSessionBefore", async (ctx, payload) => {
  const w = workspaceSvc(ctx);
  try {
    const r = await w.insertSessionBefore({
      workspaceId: payload.workspaceId,
      sessionId: payload.sessionId,
      beforeSessionId: payload.beforeSessionId,
    });
    return { workspace: workspaceView(r && r.workspace ? r.workspace : r) };
  } catch (e) {
    throw new RpcError("internal", "workspace.insertSessionBefore failed: " + e.message);
  }
});
method("workspace.archiveSession", async (ctx, payload) => {
  const w = workspaceSvc(ctx);
  try {
    const r = await w.archiveSession({ sessionId: payload.sessionId });
    return { archivedSessionIds: (r && r.archivedSessionIds) || [] };
  } catch (e) {
    throw new RpcError("internal", "workspace.archiveSession failed: " + e.message);
  }
});
method("workspace.unarchiveSession", async (ctx, payload) => {
  const w = workspaceSvc(ctx);
  try {
    await w.unarchiveSession({ sessionId: payload.sessionId });
    return { archivedSessionIds: [] };
  } catch (e) {
    throw new RpcError("internal", "workspace.unarchiveSession failed: " + e.message);
  }
});
method("workspace.deleteSession", async (ctx, payload) => {
  const sessions = sessionSvc(ctx);
  try {
    const s = sessions.get(payload.sessionId);
    if (s && typeof s.dispose === "function") await s.dispose();
    else if (sessions.remove && typeof sessions.remove === "function") await sessions.remove(payload.sessionId);
  } catch (e) {
    throw new RpcError("internal", "workspace.deleteSession failed: " + e.message);
  }
  return { deleted: true };
});

// ---------------------------------------------------------------------------
// settings.*  —— 白名单照搬官方 WEB_SETTINGS_NAMESPACES
// ---------------------------------------------------------------------------
const WEB_SETTINGS_NS = [
  "agent-loop",
  "shell",
  "locale",
  "permission",
  "ui-conversation",
  "ui-theme",
  "web-search-deepseek",
  "agent-presets",
];
// 动态 provider 设置 namespace（llm.listConfigurableProviders() 的 settingsNs），
// 模型添加提供方设置依赖它们被暴露（对齐官方 modelProviderNamespaces()）
function providerSettingsNs(ctx) {
  const out = [];
  try {
    const llm = ctx.get("llm");
    if (llm && typeof llm.listConfigurableProviders === "function") {
      for (const p of llm.listConfigurableProviders()) {
        if (p && p.settingsNs) out.push(String(p.settingsNs));
      }
    }
  } catch { /* ignore */ }
  return out;
}
function webSettingsAllow(ctx, ns) {
  const allowed = new Set(WEB_SETTINGS_NS);
  for (const pns of providerSettingsNs(ctx)) allowed.add(pns);
  return allowed.has(String(ns));
}
method("settings.describe", async (ctx, payload) => {
  const settings = requireSvc(ctx, "settings");
  let namespaces = [];
  try {
    if (typeof settings.describe === "function") {
      // 官方：settings.describe({redactSecrets:true}) 同步返回数组 [{ns,schema,value,base,user,applies,secrets,revision}]
      const d = settings.describe({ redactSecrets: true });
      namespaces = Array.isArray(d) ? d : (d && d.namespaces) || [];
    } else {
      namespaces = [];
    }
  } catch { /* ignore */ }
  const views = namespaces
    .filter((n) => webSettingsAllow(ctx, String(n.ns)))
    .map((n) => ({
      ns: String(n.ns),
      schema: n.schema || {},
      value: n.value || {},
      ...(n.base === undefined ? {} : { base: n.base }),
      ...(n.user === undefined ? {} : { user: n.user }),
      applies: n.applies || "restart",
      secrets: (n.secrets || []).map((s) => ({ path: [...(s.path || [])], set: s.set })),
      revision: n.revision || 0,
    }));
  if (!views.length) {
    // 服务不可用：返回静态空壳，前端设置页不会白屏
    for (const ns of WEB_SETTINGS_NS) {
      views.push({ ns, schema: {}, value: {}, applies: "restart", secrets: [], revision: 0 });
    }
  }
  return { writable: settings.writable !== false, hasDocument: !!settings.documentPath, namespaces: views };
});
async function settingsNsView(ctx, ns, settings, value) {
  // 从 describe 查真实 schema/value/revision
  let schema = {}, current = value, applies = "restart", secrets = [], revision = 0;
  try {
    if (settings && typeof settings.describe === "function") {
      const all = settings.describe({ redactSecrets: true });
      const d = (Array.isArray(all) ? all : all.namespaces || []).find((n) => String(n.ns) === String(ns));
      if (d) {
        schema = d.schema || {};
        if (current === undefined) current = d.value;
        applies = d.applies || "restart";
        secrets = (d.secrets || []).map((s) => ({ path: [...(s.path || [])], set: s.set }));
        revision = d.revision || 0;
      }
    }
  } catch { /* ignore */ }
  return { ns: String(ns), schema, value: current || {}, applies, secrets, revision };
}
method("settings.update", async (ctx, payload) => {
  const settings = requireSvc(ctx, "settings");
  const ns = payload.ns;
  if (!webSettingsAllow(ctx, ns)) {
    throw new RpcError("settings-not-exposed", `settings namespace "${ns}" is not exposed to configuration clients`);
  }
  try {
    // 官方签名：settings.update(ns, section, expectedRevision) —— 三位置参数，ns 为品牌字符串
    await settings.update(ns, payload.section !== undefined ? payload.section : payload.patch, payload.expectedRevision);
  } catch (e) {
    throw new RpcError("settings-rejected", "settings.update failed: " + (e && e.message));
  }
  return await settingsNsView(ctx, ns, settings);
});
method("settings.replace", async (ctx, payload) => {
  const settings = requireSvc(ctx, "settings");
  if (!webSettingsAllow(ctx, payload.ns)) {
    throw new RpcError("settings-not-exposed", `settings namespace "${payload.ns}" is not exposed to configuration clients`);
  }
  try {
    await settings.replace(payload.ns, payload.section, payload.expectedRevision);
  } catch (e) {
    throw new RpcError("settings-rejected", "settings.replace failed: " + (e && e.message));
  }
  return await settingsNsView(ctx, payload.ns, settings);
});
method("settings.mutate", async (ctx, payload) => {
  const settings = requireSvc(ctx, "settings");
  if (!webSettingsAllow(ctx, payload.ns)) {
    throw new RpcError("settings-not-exposed", `settings namespace "${payload.ns}" is not exposed to configuration clients`);
  }
  try {
    // 官方签名：settings.mutate(ns, ops, expectedRevision)——ops 是 op 数组
    await settings.mutate(payload.ns, payload.ops || [], payload.expectedRevision);
  } catch (e) {
    throw new RpcError("settings-rejected", "settings.mutate failed: " + (e && e.message));
  }
  return await settingsNsView(ctx, payload.ns, settings);
});
method("settings.openDocument", async (ctx, payload) => {
  return { opened: true };
});

// ---------------------------------------------------------------------------
// credentials.*
// ---------------------------------------------------------------------------
method("credentials.describe", async (ctx, payload) => {
  const creds = ctx.get("credentials");
  const refs = payload.refs || [];
  if (!creds) {
    const out = {};
    for (const r of refs) out[r] = { configured: false, source: undefined, writable: true };
    return { credentials: out };
  }
  const out = {};
  try {
    const d = typeof creds.describe === "function" ? await creds.describe(refs) : {};
    const map = d && d.credentials ? d.credentials : d || {};
    for (const r of refs) {
      const v = map[r];
      out[r] = {
        configured: !!(v && v.configured),
        source: v && v.source,
        writable: v ? !!v.writable : true,
      };
    }
  } catch (e) {
    for (const r of refs) out[r] = { configured: false, source: undefined, writable: true };
  }
  return { credentials: out };
});
method("credentials.set", async (ctx, payload) => {
  const creds = ctx.get("credentials");
  if (!creds || typeof creds.set !== "function") {
    throw new RpcError("credential-rejected", "credentials service not mounted", { ref: String((payload && payload.ref) || "") });
  }
  await creds.set({ ref: payload.ref, value: payload.value });
  return {};
});
method("credentials.unset", async (ctx, payload) => {
  const creds = ctx.get("credentials");
  if (!creds || typeof creds.unset !== "function") {
    throw new RpcError("credential-rejected", "credentials service not mounted", { ref: String((payload && payload.ref) || "") });
  }
  await creds.unset({ ref: payload.ref });
  return {};
});

// ---------------------------------------------------------------------------
// agentPreset.*  —— 读侧完整，写侧降级
// ---------------------------------------------------------------------------
method("agentPreset.list", async (ctx, payload) => {
  const presets = ctx.get("agentPresets");
  if (!presets) {
    return { presets: [], authorable: false, hasDocument: false };
  }
  try {
    const list = await presets.list();
    const defaultId = presets.defaultId;
    return {
      presets: (Array.isArray(list) ? list : []).map((p) => ({
        id: p.id,
        trust: p.trust || "system",
        isDefault: p.id === defaultId,
        name: p.name,
        description: p.description,
        broken: p.broken,
      })),
      authorable: !!presets.authorable,
      hasDocument: false,
    };
  } catch (e) {
    return { presets: [], authorable: false, hasDocument: false };
  }
});
method("agentPreset.select", async (ctx, payload) => {
  const presets = ctx.get("agentPresets");
  const session = requireSession(ctx, payload.sessionId);
  try {
    if (presets && typeof presets.select === "function") {
      await presets.select({ sessionId: payload.sessionId, agentPreset: payload.agentPreset });
    } else {
      session.agentPreset = payload.agentPreset;
    }
  } catch (e) {
    session.agentPreset = payload.agentPreset;
  }
  return { agentPreset: payload.agentPreset };
});
method("agentPreset.read", async (ctx, payload) => {
  const presets = ctx.get("agentPresets");
  if (!presets || typeof presets.read !== "function") {
    // 降级：从 list 结果里拼
    const listR = await dispatch["agentPreset.list"](ctx, {});
    const hit = listR.presets.find((p) => p.id === payload.agentPreset);
    if (!hit) throw new RpcError("agent-preset-not-found", `preset "${payload.agentPreset}" not found`, { agentPreset: payload.agentPreset, available: listR.presets.map((p) => p.id) });
    return {
      agentPreset: hit.id,
      trust: hit.trust,
      content: hit.description || "",
      name: hit.name,
      description: hit.description,
    };
  }
  try {
    // 官方：presets.resolve(agentPreset) 解析 id，然后 presets.read(preset.id) 读内容
    const resolved = await presets.resolve(payload.agentPreset);
    const content = await presets.read(resolved.id);
    return {
      agentPreset: resolved.id,
      trust: resolved.trust || "user",
      content: content || "",
      ...(resolved.name === undefined ? {} : { name: resolved.name }),
      ...(resolved.description === undefined ? {} : { description: resolved.description }),
    };
  } catch (e) {
    throw new RpcError("agent-preset-not-found", `preset "${payload.agentPreset}" not found: ${e.message}`, { agentPreset: payload.agentPreset, available: [] });
  }
});
method("agentPreset.copy", async (ctx, payload) => {
  // 写侧（创建自定义 preset）：降级为拒绝，避免半成品状态
  throw new RpcError("agent-preset-read-only", "agentPreset.copy is not available on the phone", { agentPreset: String((payload && payload.agentPreset) || ""), reason: "phone downgrade" });
});
method("agentPreset.openDocument", async (ctx, payload) => {
  return { opened: false, path: "" };
});
method("agentPreset.remove", async (ctx, payload) => {
  const presets = ctx.get("agentPresets");
  if (!presets || typeof presets.remove !== "function") {
    throw new RpcError("agent-preset-read-only", "agentPreset.remove is not available on the phone", { agentPreset: String((payload && payload.agentPreset) || ""), reason: "phone downgrade" });
  }
  await presets.remove({ agentPreset: payload.agentPreset });
  return {};
});

// ---------------------------------------------------------------------------
// skill.*
// ---------------------------------------------------------------------------
method("skill.list", async (ctx, payload) => {
  const skills = ctx.get("skills");
  if (!skills || typeof skills.list !== "function") {
    return { skills: [] };
  }
  try {
    const list = await skills.list({ sessionId: payload.sessionId });
    const arr = Array.isArray(list) ? list : (list && list.skills) || [];
    return {
      skills: arr.map((s) => ({
        name: s.name || s.id,
        description: s.description || "",
        whenToUse: s.whenToUse,
        modelInvocable: s.modelInvocable !== false,
      })),
    };
  } catch (e) {
    return { skills: [] };
  }
});

// ---------------------------------------------------------------------------
// subagent.*  —— 子代理面板（v3 首发）
// ---------------------------------------------------------------------------
function subagentSvc(ctx) {
  return requireSvc(ctx, "subagents");
}
method("subagent.list", async (ctx, payload) => {
  try {
    const subs = subagentSvc(ctx);
    const r = typeof subs.list === "function" ? subs.list({ parentSessionId: payload.parentSessionId }) : null;
    const entries = (r && r.entries) || (Array.isArray(r) ? r : []);
    return { entries: entries.map(normalizeSubagentEntry), parentAvailable: true };
  } catch (e) {
    if (e instanceof RpcError) throw e;
    return { entries: [], parentAvailable: false };
  }
});
function normalizeSubagentEntry(e) {
  if (e.kind === "diagnostic") return e;
  return {
    kind: "child",
    id: e.id,
    mode: e.mode || "continuable",
    activity: e.activity || "inactive",
    hasChildren: !!e.hasChildren,
    label: e.label,
  };
}
method("subagent.history", async (ctx, payload) => {
  const subs = subagentSvc(ctx);
  const r = await subs.history({
    parentSessionId: payload.parentSessionId,
    childSessionId: payload.childSessionId,
    beforeSeq: payload.beforeSeq,
    maxMessages: payload.maxMessages,
  });
  return {
    events: ((r && r.events) || []).map((h) => ({ event: normalizeEvent(h.event || h), view: h.view })),
    hasMore: !!(r && r.hasMore),
    projections: r && r.projections,
  };
});
method("subagent.prompt", async (ctx, payload) => {
  const subs = subagentSvc(ctx);
  const r = await subs.prompt({
    parentSessionId: payload.parentSessionId,
    childSessionId: payload.childSessionId,
    content: payload.content,
  });
  return { messageId: (r && r.messageId) || "" };
});
method("subagent.interrupt", async (ctx, payload) => {
  const subs = subagentSvc(ctx);
  try {
    await subs.interrupt({ parentSessionId: payload.parentSessionId, childSessionId: payload.childSessionId });
  } catch { /* ignore */ }
  return { accepted: true };
});

// ---------------------------------------------------------------------------
// goal.*  —— 目标投影走事件流，变更走 RPC
// ---------------------------------------------------------------------------
function goalSvc(ctx) {
  return requireSvc(ctx, "goals");
}
function goalRef(payload) {
  if (!payload || !payload.ref || !payload.ref.id) {
    throw new RpcError("bad-request", "goal requires a ref with id and revision");
  }
  return { id: payload.ref.id, revision: payload.ref.revision };
}
method("goal.create", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const r = await g.create({ sessionId: payload.sessionId, objective: payload.objective, maxGoalRounds: payload.maxGoalRounds });
  return { ref: r && r.ref ? r.ref : r };
});
method("goal.edit", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const r = await g.edit({ sessionId: payload.sessionId, ref: goalRef(payload), objective: payload.objective, maxGoalRounds: payload.maxGoalRounds });
  return { ref: r && r.ref ? r.ref : r };
});
method("goal.pause", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const r = await g.pause({ sessionId: payload.sessionId, ref: goalRef(payload) });
  return { ref: r && r.ref ? r.ref : r };
});
method("goal.resume", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const r = await g.resume({ sessionId: payload.sessionId, ref: goalRef(payload) });
  return { ref: r && r.ref ? r.ref : r };
});
method("goal.complete", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const r = await g.complete({ sessionId: payload.sessionId, ref: goalRef(payload) });
  return { ref: r && r.ref ? r.ref : r };
});
method("goal.clear", async (ctx, payload) => {
  const g = goalSvc(ctx);
  await g.clear({ sessionId: payload.sessionId, ref: goalRef(payload) });
  return { cleared: true };
});

// ---------------------------------------------------------------------------
// Typert 斜杠端点 —— 前端 ctx.remote.* 走 /api/<ns>/<method>（信封 method 也带斜杠，
// payload 为 {args:{agentId,...}}），与官方 Wire 协议一致。
// commands.* 直接透传官方 ctx.get('commands') 服务（host 已装配 dsh-commands），
// 手机端命令目录与电脑端完全同步；goal.* 复用上方点号实现（Typert 包装解包）。
// ---------------------------------------------------------------------------
function typertAgentId(payload) {
  const args = (payload && payload.args) || payload || {};
  const id = args.agentId != null ? args.agentId : args.sessionId;
  if (!id) throw new RpcError("bad-request", 'remote call missing "agentId"', { missing: "agentId" });
  return id;
}
function commandsSvc(ctx) {
  const c = ctx.get("commands");
  // 官方 dsh-commands 服务在 host 装配（探测确认：list(agent) 返回 7 个命令）
  return c && typeof c.list === "function" ? c : null;
}
function agentForId(ctx, agentId) {
  const agents = ctx.get("agents");
  if (!agents || typeof agents.get !== "function") return null;
  try {
    const a = agents.get(agentId);
    if (a) return a;
  } catch {
    /* fallthrough */
  }
  // 兜底：从列表里按 id 匹配
  try {
    const all = typeof agents.list === "function" ? agents.list() : [];
    for (const a of all) {
      if (a && (a.id === agentId || (a.session && a.session.id === agentId))) return a;
    }
  } catch {
    /* ignore */
  }
  return null;
}
method("commands/list", async (ctx, payload) => {
  const c = commandsSvc(ctx);
  if (!c) return []; // 命令服务缺失时降级空目录（前端可正常打开菜单）
  const agentId = typertAgentId(payload);
  const agent = agentForId(ctx, agentId);
  if (!agent) {
    throw new RpcError("session-not-found", `session "${agentId}" not found`, { sessionId: agentId });
  }
  const r = c.list(agent);
  return Array.isArray(r) ? r : [];
});
method("commands/execute", async (ctx, payload) => {
  const c = commandsSvc(ctx);
  const args = (payload && payload.args) || payload || {};
  const line = args.line;
  if (typeof line !== "string" || !line.trim()) {
    throw new RpcError("bad-request", 'commands/execute requires a non-empty "line" argument', { missing: "line" });
  }
  if (!c) {
    throw new RpcError("command-error", "command service not mounted", {});
  }
  const agentId = typertAgentId(payload);
  const agent = agentForId(ctx, agentId);
  if (!agent) {
    throw new RpcError("session-not-found", `session "${agentId}" not found`, { sessionId: agentId });
  }
  // 官方签名 execute(agent, line, signal?)；无命令解析成功时返回 undefined
  let r;
  try {
    const ac = new AbortController();
    r = await c.execute(agent, line, ac.signal);
  } catch (e) {
    throw new RpcError("command-error", String((e && e.message) || e), {});
  }
  if (r === undefined || r === null) {
    throw new RpcError("unknown-command", `unknown command: ${line}`, {});
  }
  return r; // { commandId, result:{ kind, text?, sourceEventSeq? } }
});
// goals/* —— Typert 包装：args = {agentId, ref, request:{objective,maxGoalRounds}}
method("goals/list", async (ctx, payload) => {
  // 官方 goals 服务无 list RPC（目标走事件流 projection）；返回空表避免前端报错
  return { items: [] };
});
method("goals/create", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const args = (payload && payload.args) || payload || {};
  const sessionId = typertAgentId(payload);
  const rr = await g.create({ sessionId, objective: args.request && args.request.objective, maxGoalRounds: args.request && args.request.maxGoalRounds });
  return { ref: rr && rr.ref ? rr.ref : rr };
});
method("goals/edit", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const args = (payload && payload.args) || payload || {};
  const sessionId = typertAgentId(payload);
  const ref = { id: args.ref && args.ref.id, revision: args.ref && args.ref.revision };
  if (!ref.id) throw new RpcError("bad-request", "goal requires a ref with id and revision");
  const rr = await g.edit({ sessionId, ref, objective: args.request && args.request.objective, maxGoalRounds: args.request && args.request.maxGoalRounds });
  return { ref: rr && rr.ref ? rr.ref : rr };
});
method("goals/pause", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const args = (payload && payload.args) || payload || {};
  const sessionId = typertAgentId(payload);
  const ref = { id: args.ref && args.ref.id, revision: args.ref && args.ref.revision };
  if (!ref.id) throw new RpcError("bad-request", "goal requires a ref with id and revision");
  const rr = await g.pause({ sessionId, ref });
  return { ref: rr && rr.ref ? rr.ref : rr };
});
method("goals/resume", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const args = (payload && payload.args) || payload || {};
  const sessionId = typertAgentId(payload);
  const ref = { id: args.ref && args.ref.id, revision: args.ref && args.ref.revision };
  if (!ref.id) throw new RpcError("bad-request", "goal requires a ref with id and revision");
  const rr = await g.resume({ sessionId, ref });
  return { ref: rr && rr.ref ? rr.ref : rr };
});
method("goals/complete", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const args = (payload && payload.args) || payload || {};
  const sessionId = typertAgentId(payload);
  const ref = { id: args.ref && args.ref.id, revision: args.ref && args.ref.revision };
  if (!ref.id) throw new RpcError("bad-request", "goal requires a ref with id and revision");
  const rr = await g.complete({ sessionId, ref });
  return { ref: rr && rr.ref ? rr.ref : rr };
});
method("goals/clear", async (ctx, payload) => {
  const g = goalSvc(ctx);
  const args = (payload && payload.args) || payload || {};
  const sessionId = typertAgentId(payload);
  const ref = { id: args.ref && args.ref.id, revision: args.ref && args.ref.revision };
  if (!ref.id) throw new RpcError("bad-request", "goal requires a ref with id and revision");
  await g.clear({ sessionId, ref });
  return { cleared: true };
});
// messageFeedback / pluginInventory —— 前端 remote 也走斜杠；降级空实现
method("messageFeedback/put", async () => ({ ok: true }));
method("messageFeedback/delete", async () => ({ ok: true }));
method("messageFeedback/list", async () => ({ items: [] }));
method("pluginInventory/list", async () => ({ entries: [], total: 0 }));

// ---------------------------------------------------------------------------
// host.*  —— 目录操作对手机降级（file input 兜底），describe/version 必需
// ---------------------------------------------------------------------------
method("host.listDirectory", async (ctx, payload) => {
  // 手机端无文件系统浏览需求；返回空结构避免前端白屏
  const home = homedir();
  const p = payload.path || home;
  return { path: p, home, crumbs: [], entries: [], truncated: false };
});
method("host.createDirectory", async (ctx, payload) => {
  throw new RpcError("directory-create-failed", "host.createDirectory is not available on the phone", { path: String((payload && payload.path) || "") });
});
method("host.openPath", async (ctx, payload) => {
  throw new RpcError("directory-unreadable", "host.openPath is not available on the phone", { path: String((payload && payload.path) || "") });
});
method("host.pickDirectory", async (ctx, payload) => {
  return { path: null };
});

// ---------------------------------------------------------------------------
// dynamicCordisRunner —— 官方 cordis 动态插件运行器（手机端无此能力，降级空值）。
// 前端 dsh-client-ui-cordis / dsh-cordis-client-runner 会调用 inventory /
// syncInspectManifest 等；返回 schema 合法的降级结果，避免前端 zod 解析失败。
// ---------------------------------------------------------------------------
method("dynamicCordisRunner/inventory", async () => []);
method("dynamicCordisRunner/syncInspectManifest", async () => null);
method("dynamicCordisRunner/getClientCode", async () => {
  return { code: "", name: "", pluginId: "", packageId: "", pluginRunId: "" };
});
method("dynamicCordisRunner/reportRenderFailure", async () => null);
method("dynamicCordisRunner/reportClientGuardFailure", async () => null);
method("dynamicCordisRunner/resolveInspectQuery", async () => ({ accepted: false }));
method("dynamicCordisRunner/resolveRequestRun", async () => ({ accepted: false }));
method("dynamicCordisRunner/settleUserRun", async () => ({
  ok: false,
  reason: "not-running",
  message: "dsh-mini has no dynamic cordis plugin runner",
  pluginId: "",
  packageId: "",
  pluginRunId: "",
  waitingFor: [],
}));
method("dynamicCordisRunner/stopFromPanel", async () => ({
  ok: false,
  reason: "plugin-missing",
  message: "dsh-mini has no dynamic cordis plugin runner",
}));
method("dynamicCordisRunner/undefineFromPanel", async () => ({
  ok: false,
  reason: "plugin-missing",
  message: "dsh-mini has no dynamic cordis plugin runner",
}));
method("dynamicCordisRunner/runHostHalf", async () => ({
  ok: false,
  message: "dsh-mini has no dynamic cordis plugin runner",
  waitingFor: [],
  startedHere: false,
}));
method("dynamicCordisRunner/invoke", async () => ({
  ok: false,
  reason: "plugin-missing",
  message: "dsh-mini has no dynamic cordis plugin runner",
  stack: "",
}));

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------
export async function handleGuiApi(ctx, methodName, payload, signal) {
  const fn = dispatch[methodName];
  if (!fn) {
    // 官方 rpcErrorSchema 是 discriminatedUnion —— code 必须在枚举内且 details 必填。
    // "method-not-found" 不在枚举，前端 zod 解析会报 invalid_union；改用枚举内的 internal。
    throw new RpcError("internal", `unknown method "${methodName}"`, {});
  }
  return await fn(ctx, payload || {}, signal);
}

export { RpcError };
export function listGuiMethods() {
  return Object.keys(dispatch).sort();
}
export function resetCatalogCache() {
  modelCatalogCache = null;
}
void PREFIX;