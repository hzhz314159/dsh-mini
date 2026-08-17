// @deepseek-ai/dsh-mini — zstd-log.js
// zstd-framed session log 读取工具（dsh-side-session 模式），供 index.js（旧手机页）
// 与 gui-api.js（v3 GUI history）共用。模块级缓存跨两处共享。
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528 LE
const FILE_MAP_TTL_MS = 60_000;
const MAX_LOG_EVENTS = 4000;

export { ZSTD_MAGIC };

export function scanFrame(buf, offset) {
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

export function decompressZstd(buf) {
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

export function decompressFrames(buf, from) {
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

export function parseLines(text) {
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

// Walk <dshHome>/sessions/**/session.jsonl.zstd once, mapping session id -> file.
let fileMapCache = { at: 0, map: new Map() };

export function resetFileMapCache() {
  fileMapCache = { at: 0, map: new Map() };
}

export function walkSessionFiles(dshHome) {
  const now = Date.now();
  if (now - fileMapCache.at < FILE_MAP_TTL_MS && fileMapCache.map.size > 0) {
    return fileMapCache.map;
  }
  const map = new Map();
  const root = join(dshHome, "sessions");
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
              } catch {
                /* skip */
              }
            }
          } else {
            try {
              head = JSON.parse(buf.toString("utf8").split("\n", 1)[0]);
            } catch {
              /* skip */
            }
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
  } catch {
    /* skip */
  }
  fileMapCache = { at: now, map };
  return map;
}

export function findSessionFile(dshHome, sessionId) {
  const map = walkSessionFiles(dshHome);
  if (map.has(sessionId)) return map.get(sessionId);
  const cands = [];
  if (sessionId.startsWith("session-")) cands.push(sessionId.slice("session-".length));
  else cands.push("session-" + sessionId);
  for (const c of cands) {
    if (map.has(c)) return map.get(c);
  }
  return "";
}

// ---- fold helpers over raw log events ----
export function freshFoldState() {
  return { events: [], title: "", model: null, updatedAt: 0 };
}

export function foldInto(state, evs) {
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

const foldCache = new Map();
function capMap(map, max) {
  if (map.size <= max) return;
  let extra = map.size - max;
  for (const key of map.keys()) {
    map.delete(key);
    if (--extra <= 0) break;
  }
}

export function foldLogEvents(file) {
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
      state = cached.state;
      frameEnd = cached.frameEnd;
    }
  }
  if (!state) {
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

// 完整日志事件流（GUI history 用，不裁剪）
export function readAllLogEvents(file) {
  try {
    const buf = readFileSync(file);
    const firstMagic = buf.length >= 4 ? buf.readUInt32LE(0) : 0;
    const raw = firstMagic === ZSTD_MAGIC ? decompressZstd(buf) : buf.toString("utf8");
    return parseLines(raw);
  } catch {
    return [];
  }
}

export function dshHome() {
  return process.env.DSH_HOME || homedir() + "/.dsh";
}