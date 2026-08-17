
  "use strict";
  const LS_URL = "dshmini_url", LS_TOKEN = "dshmini_token";
  const thread = document.getElementById("thread");
  const threadName = document.getElementById("thread-name");
  const threadMenu = document.getElementById("thread-menu");
  const threadButton = document.getElementById("thread-button");
  const textareaEl = document.getElementById("text");
  const sendBtn = document.getElementById("send");
  const modelBadge = document.getElementById("model-badge");
  const modelText = document.getElementById("model-text");
  const modelMenu = document.getElementById("model-menu");
  const modelScrim = document.getElementById("model-scrim");
  const balanceChip = document.getElementById("balance-chip");
  const balanceText = document.getElementById("balance-text");
  const routeText = document.getElementById("route-text");
  const routeBadge = document.getElementById("route-badge");
  const newThreadBtn = document.getElementById("new-thread");
  const dayNote = document.getElementById("day-note");
  const statusRing = document.getElementById("status-ring");
  const keepAwakeBtn = document.getElementById("keep-awake");
  const settingsBtn = document.getElementById("settings-btn");
  const attachBtn = document.getElementById("attach");
  const fileInput = document.getElementById("file-input");
  const scanInput = document.getElementById("scan-input");
  const attachChips = document.getElementById("attach-chips");

  // 扫码进入：URL 里的 ?token= 自动保存（GPT Mini 同款）
  (function initQueryToken() {
    const qt = new URLSearchParams(location.search).get("token");
    if (qt) localStorage.setItem(LS_TOKEN, qt.trim());
  })();

  function apiBase() {
    const v = localStorage.getItem(LS_URL);
    return (v && v.trim()) ? v.trim().replace(/\/+$/, "") : location.origin + "/dsh-mini/api";
  }
  function token() { return (localStorage.getItem(LS_TOKEN) || "").trim(); }
  function authHeader() { const t = token(); return t ? { "Authorization": "Bearer " + t } : {}; }
  function qs() { const t = token(); return t ? ("?token=" + encodeURIComponent(t)) : ""; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
  async function apiGet(path) {
    const r = await fetch(apiBase() + path, { headers: authHeader() });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  // ---------- 路由徽章 ----------
  (function initRoute() {
    const h = location.hostname;
    const local = h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "";
    routeText.textContent = local ? "本地" : "远程";
    routeBadge.classList.toggle("is-route-local", local);
    routeBadge.classList.toggle("is-route-remote", !local);
  })();

  // ---------- 保持亮屏 ----------
  let wakeLock = null, napping = false;
  async function keepAwake(on) {
    keepAwakeBtn.textContent = on ? "☀" : "☾";
    keepAwakeBtn.classList.toggle("is-live", on);
    if (!on) { try { if (wakeLock) wakeLock.release(); } catch {} napping = false; return; }
    napping = true;
    try { if ("wakeLock" in navigator) { wakeLock = await navigator.wakeLock.request("screen"); } } catch {}
  }
  keepAwakeBtn.onclick = () => keepAwake(!napping);
  document.addEventListener("visibilitychange", () => { if (napping && document.visibilityState === "visible") keepAwake(true); });

  // ---------- 状态 ----------
  let threads = [], currentId = null, es = null, seenSeqs = new Set();
  let curMsg = null, curThinking = null;
  let busy = false;
  let attachments = [];   // {name, size, mime, path, isImage, status}
  let modelCatalog = null; // {models, default}
  let currentModel = null; // {provider, model, reasoningEffort}

  function setBusy(on) {
    busy = on;
    sendBtn.innerHTML = on ? '<span class="stop-square"></span>' : "↑";
    sendBtn.title = on ? "停止生成" : "发送";
    document.body.classList.toggle("dot-orange", on);
  }
  setBusy(false);

  // ---------- 轻量 markdown ----------
  function mdInline(s) {
    return esc(s)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\`([^\`]+)\`/g, "<code>$1</code>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  }
  function mdRender(el, text) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let inCode = false, codeBuf = [];
    for (const line of lines) {
      const fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        if (!inCode) { inCode = true; codeBuf = []; }
        else { inCode = false; out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>"); }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      const t = line.trim();
      if (!t) continue;
      if (/^#{1,3}\s/.test(t)) {
        const lvl = t.match(/^(#{1,3})\s/)[1].length;
        out.push("<h" + lvl + ">" + mdInline(t.replace(/^#{1,3}\s/, "")) + "</h" + lvl + ">");
      } else if (/^[-*]\s/.test(t)) {
        out.push("<li>" + mdInline(t.replace(/^[-*]\s/, "")) + "</li>");
      } else if (/^\d+\.\s/.test(t)) {
        out.push("<li>" + mdInline(t.replace(/^\d+\.\s/, "")) + "</li>");
      } else if (/^>\s?/.test(t)) {
        out.push("<blockquote>" + mdInline(t.replace(/^>\s?/, "")) + "</blockquote>");
      } else {
        out.push("<p>" + mdInline(t) + "</p>");
      }
    }
    if (inCode) out.push("<pre><code>" + esc(codeBuf.join("\n")) + "</code></pre>");
    el.innerHTML = out.join("");
  }

  // ---------- 模型徽章 / 菜单 ----------
  function modelLabel(m) {
    if (!m || !m.model) return "--";
    const short = String(m.model).split("/").pop();
    return m.reasoningEffort ? short + "·" + m.reasoningEffort : short;
  }
  function setModelBadge(m) {
    currentModel = m || null;
    modelText.textContent = modelLabel(currentModel);
  }
  async function refreshModel() {
    if (!currentId) return;
    try {
      const d = await apiGet("/threads/" + encodeURIComponent(currentId) + "/model");
      setModelBadge(d);
    } catch {}
  }
  function toggleModelMenu(open) {
    const want = open == null ? !modelMenu.classList.contains("is-open") : open;
    modelMenu.classList.toggle("is-open", want);
    if (!want) return;
    toggleMenu(false);
    renderModelMenu();
    if (!modelCatalog) {
      modelMenu.innerHTML = '<div class="empty-thread-menu">加载模型列表…</div>';
      apiGet("/models").then(d => { modelCatalog = d; renderModelMenu(); })
        .catch(e => { modelMenu.innerHTML = '<div class="empty-thread-menu">模型列表加载失败：' + esc(e.message) + "</div>"; });
    }
  }
  function renderModelMenu() {
    modelMenu.innerHTML = "";
    if (!modelCatalog || !Array.isArray(modelCatalog.models) || !modelCatalog.models.length) {
      const empty = document.createElement("div");
      empty.className = "empty-thread-menu";
      empty.textContent = "没有可用模型";
      modelMenu.appendChild(empty);
      return;
    }
    const byProvider = new Map();
    for (const m of modelCatalog.models) {
      if (!byProvider.has(m.provider)) byProvider.set(m.provider, []);
      byProvider.get(m.provider).push(m);
    }
    for (const [provider, list] of byProvider) {
      const section = document.createElement("section");
      section.className = "thread-section";
      const label = document.createElement("div");
      label.className = "thread-section-label";
      label.textContent = provider;
      section.appendChild(label);
      for (const m of list) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "model-row";
        const sel = currentModel && currentModel.provider === m.provider && currentModel.model === m.model;
        if (sel) row.classList.add("sel");
        row.innerHTML = '<div class="mr-name"><span>' + esc(m.name) +
          (sel ? " ✓" : "") + "</span></div>" +
          (m.description ? '<div class="mr-desc">' + esc(m.description) + "</div>" : "");
        row.onclick = () => selectModel(m.provider, m.model, m.defaultReasoningEffort || undefined);
        if (Array.isArray(m.reasoningEfforts) && m.reasoningEfforts.length > 1) {
          const er = document.createElement("div");
          er.className = "effort-row";
          for (const e of m.reasoningEfforts) {
            const chip = document.createElement("button");
            chip.type = "button";
            chip.className = "effort-chip" + (sel && currentModel.reasoningEffort === e.id ? " sel" : "");
            chip.textContent = e.name;
            chip.onclick = (ev) => { ev.stopPropagation(); selectModel(m.provider, m.model, e.id); };
            er.appendChild(chip);
          }
          row.appendChild(er);
        }
        section.appendChild(row);
      }
      modelMenu.appendChild(section);
    }
  }
  async function selectModel(provider, model, effort) {
    try {
      const r = await fetch(apiBase() + "/threads/" + encodeURIComponent(currentId) + "/model", {
        method: "POST", headers: Object.assign({}, authHeader(), { "Content-Type": "application/json" }),
        body: JSON.stringify({ provider, model, reasoningEffort: effort || undefined }),
      });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      setModelBadge({ provider: d.provider, model: d.model, reasoningEffort: d.reasoningEffort });
      toggleModelMenu(false);
      showNotice("模型已切换：" + modelLabel(currentModel), false);
    } catch (e) {
      showNotice("切换失败：" + e.message, true);
    }
  }
  modelBadge.onclick = () => toggleModelMenu();
  modelScrim.onclick = () => toggleModelMenu(false);

  // ---------- 余额（桌面端同步 → host 缓存 → 手机） ----------
  function renderBalance(d) {
    balanceChip.hidden = false;
    const payload = d && d.balance;
    if (!payload || payload.ok === false || payload.disabled === true) {
      balanceText.textContent = "余额未启用";
      balanceChip.classList.add("off");
      balanceChip.title = "余额未启用或桌面端未同步";
      return;
    }
    const arr = Array.isArray(payload.balances) ? payload.balances : [];
    if (arr.length) {
      const b = arr[0];
      const amount = b.amount != null ? b.amount : (b.balance != null ? b.balance : null);
      const cur = b.currency || b.symbol || "";
      balanceText.textContent = (cur ? cur + " " : "") + (amount != null ? amount : "—");
      balanceChip.classList.remove("off");
      const at = d.updatedAt ? new Date(d.updatedAt).toLocaleTimeString() : "";
      balanceChip.title = "余额（" + at + "同步，点击刷新）";
    } else {
      balanceText.textContent = "余额待同步";
      balanceChip.classList.add("off");
      balanceChip.title = "等待桌面端推送余额数据";
    }
  }
  async function refreshBalance() {
    try {
      const d = await apiGet("/balance");
      renderBalance(d);
    } catch {}
  }
  balanceChip.onclick = () => refreshBalance();

  // ---------- 附件 ----------
  function renderAttachmentChips() {
    attachChips.innerHTML = "";
    attachChips.hidden = attachments.length === 0;
    attachments.forEach((a, i) => {
      const chip = document.createElement("span");
      chip.className = "attach-chip " + (a.status === "ok" ? "ok" : a.status === "error" ? "err" : "uploading");
      const size = a.size != null ? (a.size < 1024 ? a.size + "B" : a.size < 1048576 ? (a.size / 1024).toFixed(1) + "KB" : (a.size / 1048576).toFixed(1) + "MB") : "";
      chip.innerHTML = '<span class="ac-ico">' + (a.isImage ? "🖼" : "📄") + "</span>" +
        '<span class="ac-name">' + esc(a.name) + "</span>" +
        (size ? '<span class="ac-size">' + size + "</span>" : "") +
        (a.status === "error" ? " ✕" : "");
      const x = document.createElement("button");
      x.type = "button";
      x.className = "ac-x";
      x.textContent = "×";
      x.title = "移除";
      x.onclick = () => { attachments.splice(i, 1); renderAttachmentChips(); };
      chip.appendChild(x);
      attachChips.appendChild(chip);
    });
  }
  async function uploadAttachment(f) {
    const chip = { name: f.name, size: f.size, mime: f.type || "", path: null, isImage: (f.type || "").startsWith("image/"), status: "uploading" };
    attachments.push(chip);
    renderAttachmentChips();
    try {
      const up = apiBase() + "/upload?session=" + encodeURIComponent(currentId) + "&name=" + encodeURIComponent(f.name);
      const r = await fetch(up, { method: "POST", headers: authHeader(), body: f });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const d = await r.json();
      chip.path = d.path; chip.name = d.name || chip.name; chip.size = d.size; chip.mime = d.mime; chip.isImage = d.isImage; chip.status = "ok";
    } catch (e) {
      chip.status = "error";
      showNotice("上传失败：" + e.message, true);
    }
    renderAttachmentChips();
  }
  attachBtn.onclick = () => {
    if (!currentId) { showNotice("先选择或新建一个会话", true); return; }
    fileInput.click();
  };
  fileInput.onchange = () => {
    if (!currentId) { showNotice("先选择或新建一个会话", true); return; }
    const files = Array.prototype.slice.call(fileInput.files || []);
    for (const f of files) uploadAttachment(f);
    fileInput.value = "";
  };

  // ---------- 步骤渲染 ----------
  function applyStep(s, fromHistory) {
    if (s.seq != null) {
      if (seenSeqs.has(s.seq)) return;
      seenSeqs.add(s.seq);
    }
    switch (s.type) {
      case "thinking": {
        if (!curThinking) {
          curThinking = document.createElement("div");
          curThinking.className = "message assistant";
          const wrap = document.createElement("div");
          wrap.className = "bubble-wrap";
          const inner = document.createElement("div");
          inner.className = "process-thinking";
          wrap.appendChild(inner);
          curThinking.appendChild(wrap);
          thread.appendChild(curThinking);
        }
        curThinking.firstChild.firstChild.textContent += s.text;
        scrollDown();
        break;
      }
      case "assistant": {
        if (!curMsg) {
          curMsg = document.createElement("div");
          curMsg.className = "message assistant";
          const wrap = document.createElement("div");
          wrap.className = "bubble-wrap";
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.innerHTML = '<span class="mt">DSH</span>';
          const bubble = document.createElement("div");
          bubble.className = "bubble markdown-body";
          wrap.append(meta, bubble);
          curMsg._bubble = bubble;
          curMsg.appendChild(wrap);
          thread.appendChild(curMsg);
          if (curThinking) { curThinking.remove(); curThinking = null; }
        }
        if (curMsg._bubble) curMsg._bubble.textContent += s.text;
        scrollDown();
        break;
      }
      case "user": {
        const um = document.createElement("div");
        um.className = "message user";
        const wrap = document.createElement("div");
        wrap.className = "bubble-wrap";
        const meta = document.createElement("div");
        meta.className = "meta";
        meta.innerHTML = '<span class="mt">桌面端</span>';
        const bubble = document.createElement("div");
        bubble.className = "bubble";
        bubble.textContent = s.text || "";
        wrap.append(meta, bubble);
        um.appendChild(wrap);
        thread.appendChild(um);
        curMsg = null; curThinking = null;
        scrollDown();
        break;
      }
      case "tool": {
        if (!curMsg) {
          curMsg = document.createElement("div");
          curMsg.className = "message assistant";
          const wrap = document.createElement("div");
          wrap.className = "bubble-wrap";
          const meta = document.createElement("div");
          meta.className = "meta";
          meta.innerHTML = '<span class="mt">DSH</span>';
          const bubble = document.createElement("div");
          bubble.className = "bubble";
          wrap.append(meta, bubble);
          curMsg._bubble = bubble;
          curMsg.appendChild(wrap);
          thread.appendChild(curMsg);
        }
        let row = curMsg._toolRow;
        if (!row || !row.isConnected) {
          row = document.createElement("div");
          row.className = "process-tool-row";
          curMsg._toolRow = row;
          if (curMsg._bubble) curMsg._bubble.appendChild(row);
          else curMsg.firstChild.appendChild(row);
        }
        const pill = document.createElement("span");
        const icon = s.status === "call" ? "⚙" : (s.isError ? "✕" : "✓");
        pill.className = "process-tool" + (s.status === "call" ? "" : (s.isError ? " err" : " ok"));
        pill.innerHTML = '<span class="tg">' + icon + '</span><span class="tl">' + esc(s.tool || "") + (s.status === "call" ? " …" : "") + "</span>";
        row.appendChild(pill);
        scrollDown();
        break;
      }
      case "status": {
        if (s.status === "turn-start") setBusy(true);
        if (s.status === "turn-end") { setBusy(false); showNotice(s.reason === "completed" ? "本轮完成" : s.reason === "error" ? "本轮出错" : "已停止", s.reason === "error"); }
        break;
      }
      case "model": {
        setModelBadge({ provider: s.provider, model: s.model, reasoningEffort: s.reasoningEffort });
        break;
      }
      case "title": {
        if (s.title) {
          threadName.textContent = s.title;
          const t = threads.find(x => x.id === currentId);
          if (t) t.title = s.title;
        }
        break;
      }
    }
  }

  function scrollDown() { thread.scrollTop = thread.scrollHeight; }

  // ---------- 历史 ----------
  async function loadHistory(id, merge) {
    try {
      const r = await fetch(apiBase() + "/threads/" + encodeURIComponent(id) + "/history", { headers: authHeader() });
      if (!r.ok) return;
      const hist = await r.json();
      if (!merge || thread.childElementCount <= 1) {
        // 首次打开 / 切换会话：整表重置
        thread.innerHTML = '<div class="day-note">' + esc(hist.title || id) + "</div>";
        curMsg = null; curThinking = null;
      }
      // merge 模式：seenSeqs 去重，只补渲染缺失的新 step（避免轮询闪烁）
      for (const s of hist.steps || []) applyStep(s, true);
      if (hist.model) setModelBadge(hist.model);
      else refreshModel();
      scrollDown();
    } catch {}
  }

  // ---------- 线程菜单 ----------
  function renderThreadMenu() {
    threadMenu.innerHTML = "";
    if (!threads.length) {
      const empty = document.createElement("div");
      empty.className = "empty-thread-menu";
      empty.textContent = "还没有会话。点「＋」新建一个。";
      threadMenu.appendChild(empty);
    } else {
      const section = document.createElement("section");
      section.className = "thread-section";
      const label = document.createElement("div");
      label.className = "thread-section-label";
      label.textContent = "会话（" + threads.length + "）";
      section.appendChild(label);
      const list = document.createElement("div");
      for (const t of threads) {
        const opt = document.createElement("button");
        opt.type = "button";
        opt.className = "thread-option";
        if (t.id === currentId) opt.setAttribute("aria-current", "true");
        const st = t.live
          ? '<span class="thread-option-spinner" title="运行中"></span>'
          : '<span class="thread-option-dot idle" title="空闲"></span>';
        const tmodel = t.model ? (String(t.model.model).split("/").pop() + (t.model.reasoningEffort ? "·" + t.model.reasoningEffort : "")) : "";
        opt.innerHTML = '<span class="thread-option-title"><span class="tname">' + esc(t.title || t.id) + "</span>" +
          (tmodel ? '<span class="tmodel">' + esc(tmodel) + "</span>" : "") + "</span>" +
          '<span class="thread-option-state">' + st + "</span>";
        opt.onclick = () => { toggleMenu(false); openChat(t.id, t.title || t.id); };
        list.appendChild(opt);
      }
      section.appendChild(list);
      threadMenu.appendChild(section);
    }
    const setBtn = document.createElement("button");
    setBtn.type = "button";
    setBtn.className = "thread-menu-btn";
    setBtn.innerHTML = '<span class="tmb-ico">⚙</span><span>连接设置</span>';
    setBtn.onclick = () => { toggleMenu(false); openSettings(); };
    threadMenu.appendChild(setBtn);
  }

  function toggleMenu(open) {
    const want = open == null ? !threadMenu.classList.contains("is-open") : open;
    threadMenu.classList.toggle("is-open", want);
  }
  threadButton.onclick = () => { loadThreads(); toggleMenu(); };
  document.getElementById("thread-menu-scrim").onclick = () => toggleMenu(false);

  // ---------- 新建 ----------
  newThreadBtn.onclick = async () => {
    newThreadBtn.disabled = true;
    try {
      const r = await fetch(apiBase() + "/threads/new", { method: "POST", headers: authHeader() });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const { id } = await r.json();
      if (!id) throw new Error("响应缺少会话 id");
      await loadThreads();
      await openChat(id, "新会话");
      showNotice("已创建新会话");
    } catch (e) { showNotice("新建失败：" + e.message, true); }
    finally { newThreadBtn.disabled = false; }
  };

  // ---------- 聊天 ----------
  let ssFail = 0, syncFallbackTimer = null;
  function startSyncFallback() {
    if (syncFallbackTimer) return;
    syncFallbackTimer = setInterval(() => {
      if (currentId && ssFail >= 2) {
        // SSE 疑似被网络掐断：降级为定时拉取历史（merge 增量 + seenSeqs 去重）
        loadHistory(currentId, true);
      }
    }, 12000);
  }
  function syncAlive() { ssFail = 0; }

  async function openChat(id, title) {
    currentId = id; seenSeqs = new Set(); curMsg = null; curThinking = null;
    ssFail = 0;
    threadName.textContent = title || id;
    modelBadge.disabled = false;
    if (es) { es.close(); es = null; }
    thread.innerHTML = '<div class="day-note">加载中…</div>';
    await loadHistory(id);
    connectStream(id);
    refreshBalance();
    startSyncFallback();
  }

  function connectStream(id) {
    if (es) { try { es.close(); } catch {} es = null; }
    ssFail = 0;
    const url = apiBase() + "/threads/" + encodeURIComponent(id) + "/stream" + qs();
    const open = () => {
      es = new EventSource(url);
      const alive = () => { syncAlive(); };
      es.addEventListener("status", (e) => {
        alive();
        try { const d = JSON.parse(e.data); if (d.status === "connected") loadHistory(id, true); } catch {}
      });
      es.addEventListener("meta", (e) => {
        alive();
        try {
          const d = JSON.parse(e.data);
          if (d.title) threadName.textContent = d.title;
          if (d.model) setModelBadge(d.model);
        } catch {}
      });
      es.addEventListener("step", (e) => {
        alive();
        try { applyStep(JSON.parse(e.data), false); } catch {}
      });
      es.onerror = () => {
        ssFail++;
        try { es.close(); } catch {}
        es = null;
        // 自动重连（最多 10 次，之后交给 12s 历史兜底轮询）
        if (ssFail < 10 && currentId === id) setTimeout(open, 3000);
      };
    };
    open();
  }

  // ---------- 发送 / 停止 ----------
  const composer = document.getElementById("composer");
  composer.addEventListener("submit", (e) => { e.preventDefault(); send(); });
  sendBtn.onclick = (e) => {
    if (busy) stop();
    else send();
  };

  async function send() {
    const text = textareaEl.value.trim();
    if ((!text && !attachments.some(a => a.status === "ok")) || !currentId || busy) return;
    const um = document.createElement("div");
    um.className = "message user";
    const wrap = document.createElement("div");
    wrap.className = "bubble-wrap";
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "我";
    const bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.textContent = text || "";
    const okAtt = attachments.filter(a => a.status === "ok");
    if (okAtt.length) {
      const note = document.createElement("div");
      note.className = "attach-note";
      for (const a of okAtt) {
        const sp = document.createElement("span");
        sp.textContent = (a.isImage ? "🖼 " : "📎 ") + a.name;
        note.appendChild(sp);
      }
      bubble.appendChild(note);
    }
    wrap.append(meta, bubble);
    um.appendChild(wrap);
    thread.appendChild(um);
    textareaEl.value = ""; textareaEl.style.height = "auto";
    curMsg = null; curThinking = null;
    setBusy(true);
    scrollDown();
    try {
      const body = { text: text || "（附件）", attachments: okAtt.map(a => ({ name: a.name, path: a.path })) };
      const r = await fetch(apiBase() + "/threads/" + encodeURIComponent(currentId) + "/send", {
        method: "POST", headers: Object.assign({}, authHeader(), { "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      if (!r.ok) { setBusy(false); showNotice("发送失败：HTTP " + r.status, true); }
      else { attachments = []; renderAttachmentChips(); }
    } catch (err) { setBusy(false); showNotice("发送失败：" + err.message, true); }
  }

  async function stop() {
    if (!currentId) return;
    try {
      await fetch(apiBase() + "/threads/" + encodeURIComponent(currentId) + "/stop", { method: "POST", headers: authHeader() });
    } catch {}
  }

  // ---------- 列表刷新 ----------
  async function loadThreads() {
    try {
      const r = await fetch(apiBase() + "/threads", { headers: authHeader() });
      if (!r.ok) throw new Error("HTTP " + r.status);
      const { threads: list } = await r.json();
      threads = list || [];
      renderThreadMenu();
      const hasLive = threads.some(t => t.live);
      document.body.classList.toggle("dot-blue", hasLive && !busy);
      if (hasLive) document.body.classList.toggle("dot-flashing", busy);
      else document.body.classList.remove("dot-flashing");
    } catch (e) {
      showNotice("连接失败：" + e.message, true);
    }
  }
  setInterval(loadThreads, 15000);
  setInterval(() => { if (currentId) refreshBalance(); }, 60000);

  // ---------- notice ----------
  let noticeTimer = null;
  function showNotice(msg, isError) {
    dayNote.textContent = (isError ? "⚠ " : "") + msg;
    dayNote.style.color = isError ? "#ff8d8d" : "var(--faint)";
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      dayNote.textContent = currentId ? "" : "选择或新建一个 DSH 会话";
      dayNote.style.color = "var(--faint)";
    }, 4000);
  }

  // ---------- 扫码连接（系统相机拍照 → jsQR 解码） ----------
  function applyQrText(text) {
    let u;
    try { u = new URL(String(text).trim()); } catch { showNotice("二维码内容不是有效链接", true); return; }
    if (u.protocol === "http:" || u.protocol === "https:") {
      localStorage.setItem(LS_URL, u.origin + "/dsh-mini/api");
      const t = u.searchParams.get("token");
      if (t) localStorage.setItem(LS_TOKEN, t);
      else localStorage.removeItem(LS_TOKEN);
      closeSettings();
      loadThreads();
      showNotice("已连接 " + u.host, false);
    } else {
      showNotice("暂不支持该二维码类型（仅支持 http(s) 连接链接）", true);
    }
  }
  async function scanQrConnect(file) {
    try {
      if (typeof jsQR !== "function") throw new Error("扫码库未加载");
      const bmp = await createImageBitmap(file);
      const W = Math.min(bmp.width, 1400);
      const scale = W / bmp.width;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const code = jsQR(imgData.data, canvas.width, canvas.height);
      if (!code || !code.data) { showNotice("未识别到二维码，请对准桌面二维码重拍", true); return; }
      applyQrText(code.data);
    } catch (e) {
      showNotice("扫码失败：" + (e && e.message ? e.message : e), true);
    }
  }
  scanInput.onchange = () => {
    const f = scanInput.files && scanInput.files[0];
    scanInput.value = "";
    if (f) scanQrConnect(f);
  };

  // ---------- 设置 ----------
  const settingsCard = document.createElement("div");
  settingsCard.className = "thread-menu";
  settingsCard.id = "settings-card";
  settingsCard.style.display = "none";
  settingsCard.style.position = "fixed";
  settingsCard.style.left = "12px";
  settingsCard.style.top = "calc(max(0px, calc(env(safe-area-inset-top) - var(--topbar-safe-lift))) + var(--topbar-row-height) + 8px)";
  settingsCard.style.zIndex = "30";
  settingsCard.innerHTML =
    '<div class="thread-section-label">连接设置</div>' +
    '<input id="cfg-url" placeholder="http://192.168.x.x:端口/dsh-mini/api" style="width:100%;min-height:42px;border:1px solid rgba(255,255,255,.12);border-radius:13px;padding:0 12px;background:rgba(0,0,0,.32);color:var(--text);font:inherit;font-size:15px;outline:none;margin-bottom:8px" />' +
    '<input id="cfg-token" placeholder="桥接 Token（非本机访问需要）" style="width:100%;min-height:42px;border:1px solid rgba(255,255,255,.12);border-radius:13px;padding:0 12px;background:rgba(0,0,0,.32);color:var(--text);font:inherit;font-size:15px;outline:none;margin-bottom:10px" />' +
    '<div class="scan-btn-row">' +
    '<button class="thread-menu-btn" id="cfg-scan" style="margin-top:0;text-align:center;grid-template-columns:1fr;color:#8ef0b7;background:rgba(142,240,183,.12)">📷 扫码连接</button>' +
    '<button class="thread-menu-btn" id="cfg-paste" style="margin-top:0;text-align:center;grid-template-columns:1fr">📋 粘贴链接</button>' +
    "</div>" +
    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">' +
    '<button class="thread-menu-btn" id="cfg-cancel" style="margin-top:0;text-align:center;grid-template-columns:1fr">取消</button>' +
    '<button class="thread-menu-btn" id="cfg-save" style="margin-top:0;text-align:center;grid-template-columns:1fr;color:#5eb4ff;background:rgba(94,180,255,.12)">保存</button>' +
    "</div>";
  document.body.appendChild(settingsCard);
  function openSettings() {
    document.getElementById("cfg-url").value = localStorage.getItem(LS_URL) || "";
    document.getElementById("cfg-token").value = localStorage.getItem(LS_TOKEN) || "";
    settingsCard.style.display = "block";
  }
  function closeSettings() { settingsCard.style.display = "none"; }
  settingsBtn.onclick = openSettings;
  document.getElementById("cfg-cancel").onclick = closeSettings;
  document.getElementById("cfg-scan").onclick = () => { settingsCard.style.display = "none"; scanInput.click(); };
  document.getElementById("cfg-paste").onclick = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) applyQrText(text);
      else showNotice("剪贴板为空", true);
    } catch (e) {
      showNotice("无法读取剪贴板，请手动填写", true);
    }
  };
  document.getElementById("cfg-save").onclick = () => {
    localStorage.setItem(LS_URL, document.getElementById("cfg-url").value.trim());
    localStorage.setItem(LS_TOKEN, document.getElementById("cfg-token").value.trim());
    closeSettings();
    loadThreads();
  };

  // ---------- 输入 ----------
  textareaEl.addEventListener("input", () => { textareaEl.style.height = "auto"; textareaEl.style.height = Math.min(textareaEl.scrollHeight, 130) + "px"; });
  textareaEl.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

  // ---------- 键盘弹起 ----------
  // 首选 visualViewport（iOS/Chrome）精确位移 composer；
  // 兜底：focus/blur 直接滚动输入框进视口并标记 keyboard-open（WebView/部分安卓）。
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const onVp = () => {
      const shift = Math.max(0, vv.height - window.innerHeight);
      document.body.classList.toggle("keyboard-open", shift > 80);
      document.documentElement.style.setProperty("--keyboard-shift", (shift > 80 ? shift : 0) + "px");
    };
    vv.addEventListener("resize", onVp);
    vv.addEventListener("scroll", onVp);
  }
  textareaEl.addEventListener("focus", () => {
    document.body.classList.add("keyboard-open");
    setTimeout(() => { try { textareaEl.scrollIntoView({ block: "nearest" }); } catch {} }, 200);
  });
  textareaEl.addEventListener("blur", () => {
    document.body.classList.remove("keyboard-open");
    document.documentElement.style.removeProperty("--keyboard-shift");
  });

  // ---------- 启动 ----------
  (function boot() {
    if (navigator.standalone || matchMedia("(display-mode: standalone)").matches) document.body.classList.add("standalone");
    loadThreads();
  })();

  
