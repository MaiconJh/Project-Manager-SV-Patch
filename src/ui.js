/*
PM-SV-PATCH META
Version: pm-svpatch-ui@2026.02.11-r1
Last-Edited: 2026-02-11
Contains: UI shell, file tree, file view cards (view/edit/markdown/raw/fullscreen), toasts, patch controls UI.
Implemented in this version: (1) Refresh SVG icon fix (centered, consistent). (2) Refresh button alignment/feedback CSS (no logic changes).
*/
const { ipcRenderer } = require("electron");
const el = (id) => document.getElementById(id);

const expanded = new Set();
const expandedPaths = new Set(); // absPath set to preserve expanded state across refreshes
let selectedId = null;

let currentPipelinePath = null;
let lastSnapshot = null;

// ─────────────────────────────────────────────
// Auto-refresh (triggered by main-process watcher)
// Why: keep Files tree in sync when files are changed outside the app.
// Safety: debounced + respects existing refresh button busy-state to avoid re-entrancy.
let _autoRefreshT = null;
let _autoRefreshLastMs = 0;

function _scheduleAutoRefresh(reason) {
  try { if (_autoRefreshT) clearTimeout(_autoRefreshT); } catch {}
  _autoRefreshT = setTimeout(async () => {
    const now = Date.now();
    // throttle (avoid spam on large file operations)
    if (now - _autoRefreshLastMs < 1200) return;
    _autoRefreshLastMs = now;

    const b = el("btnRefreshFiles");
    if (b?.classList?.contains("busy")) return;

    try {
      b?.classList?.add("busy");
      showToast("Auto-refresh: changes detected…", { type: "info", ttl: 1400 });
      await ipcRenderer.invoke("project:refresh");
      showToast("Auto-refresh: files updated.", { type: "success", ttl: 1600 });
    } catch (e) {
      showToast("Auto-refresh failed. Check Logs.", { type: "error", ttl: 4200 });
    } finally {
      b?.classList?.remove("busy");
    }
  }, 650);
}



// Floating views
const fvLayer = () => document.getElementById("fileViewLayer");
let fvZ = 1000;
const fvOpen = new Map(); // absPath -> cardId

function setTabs() {
  document.querySelectorAll(".tab").forEach((t) => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      const key = t.dataset.tab;
      document.querySelectorAll(".tabPanel").forEach((p) => p.classList.remove("active"));
      document.getElementById("tab-" + key).classList.add("active");
    });
  });
}

function svgUse(id) {
  return `<svg class="ico"><use href="#${id}"></use></svg>`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


// ─────────────────────────────────────────────
// Toasts (bottom-right notifications)
const toastHost = () => document.getElementById("toastHost");

function showToast(msg, opts) {
  const host = toastHost();
  if (!host) return;

  const o = opts || {};
  const type = String(o.type || "info"); // info | success | warn | error
  const ttl = Number.isFinite(Number(o.ttl)) ? Number(o.ttl) : 2600;

  // PATCH: group duplicate toasts (same type+msg within window)
  try{
    const key = _toastKey(type, msg);
    const now = Date.now();
    const hit = _toastGroup.get(key);
    if(hit && hit.el && hit.el.isConnected && (now - (hit.lastTs||0)) < 6000){
      hit.lastTs = now;
      hit.count = (hit.count||1) + 1;
      hit.el.dataset.count = String(hit.count);
      const pill = hit.el.querySelector(".toastCount");
      if(pill){ pill.textContent = "x" + String(hit.count); pill.style.display = ""; }
      // refresh auto-dismiss timer
      if(ttl > 0){
        try{
          clearTimeout(hit._t);
          hit._t = setTimeout(()=>{ try{ hit.el?.querySelector(".toastX")?.click(); }catch{} }, ttl);
        }catch{}
      }
      // bump to end to show as most recent
      try{ host.appendChild(hit.el); }catch{}
      return;
    }
  }catch{}


  const t = document.createElement("div");
  t.className = `toast toast-${type}`;
  t.setAttribute("role", "status");
  
  t.innerHTML = `
    <div class="toastBodyWrap">
      <div class="toastBody">${escapeHtml(msg)}</div>
      <div class="toastCount" style="display:none">x1</div>
    </div>
    <button class="toastX" title="Dismiss" aria-label="Dismiss">${svgUse("icon-x")}</button>
  `;
  const kill = () => {
    if (t.dataset.dead === "1") return;
    t.dataset.dead = "1";
    t.classList.add("leaving");
    
    try{ _toastGroup.delete(_toastKey(type, msg)); }catch{}
setTimeout(() => t.remove(), 220);
  };

  t.querySelector(".toastX")?.addEventListener("click", (e) => {
    e.stopPropagation();
    kill();
  });

  // PATCH: click toast opens Logs tab (dismiss via X)
  t.addEventListener("click", () => { _openLogsTab(); });

  
  // PATCH: register toast group entry
  try{
    const key = _toastKey(type, msg);
    _toastGroup.set(key, { el: t, count: 1, lastTs: Date.now(), _t: null });
  }catch{}
host.appendChild(t);

  // auto dismiss
  if (ttl > 0) setTimeout(kill, ttl);

  // keep only last 5
  const children = Array.from(host.children);
  if (children.length > 5) {
    for (let i = 0; i < children.length - 5; i++) {
      children[i]?.remove?.();
    }
  }
}

function toastFromLog(line) {
  const s = String(line || "");
  if (!s) return;

  if (/\[PATCH\]\s+OK/i.test(s)) {
    showToast("Patch OK.", { type: "success", ttl: 2800 });
    return;
  }
  if (/\[PATCH\]\s+FAILED/i.test(s) || /\[PATCH_ERR\]/i.test(s)) {
    showToast("Patch failed. Check Logs.", { type: "error", ttl: 4200 });
    return;
  }

  // useful, non-spammy helpers
  if (/\[SUCCESS\]\s+Pipeline saved:/i.test(s)) {
    showToast("Pipeline saved.", { type: "success" });
    return;
  }
  if (/\[ERROR\]\s+Pipeline path vazio/i.test(s)) {
    showToast("Pipeline not saved yet.", { type: "warn", ttl: 3200 });
    return;
  }
  if (/\[FILE_SAVE\]\s+Saved/i.test(s)) {
    showToast("File saved.", { type: "success", ttl: 1800 });
    return;
  }
}

function fmtBytes(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let v = x;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const shown = i === 0 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2);
  return `${shown} ${units[i]}`;
}

function fileTypeIconId(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".js" || e === ".cjs" || e === ".mjs") return "icon-js";
  if (e === ".json") return "icon-json";
  if (e === ".py") return "icon-py";
  if (e === ".md" || e === ".markdown") return "icon-md";
  return "icon-file";
}

function guessLang(ext) {
  const e = String(ext || "").toLowerCase();
  if (e === ".json") return "json";
  if (e === ".js" || e === ".cjs" || e === ".mjs") return "js";
  if (e === ".py") return "py";
  if (e === ".md" || e === ".markdown") return "md";
  return "plain";
}

function highlight(content, lang) {
  // Minimal tokenizer (safe + fast enough). Not a full parser.
  const src = escapeHtml(content);

  if (lang === "json") {
    let out = src;

    // strings
    out = out.replace(/("(?:\\.|[^"\\])*")/g, `<span class="tok-string">$1</span>`);
    // numbers
    out = out.replace(/\b(-?\d+(?:\.\d+)?)\b/g, `<span class="tok-number">$1</span>`);
    // booleans/null
    out = out.replace(/\b(true|false)\b/g, `<span class="tok-boolean">$1</span>`);
    out = out.replace(/\b(null)\b/g, `<span class="tok-null">$1</span>`);
    // punctuation-ish (optional): keep default color
    return out;
  }

  if (lang === "js") {
    let out = src;
    // comments
    out = out.replace(/(\/\/[^\n]*)/g, `<span class="tok-comment">$1</span>`);
    out = out.replace(/(\/\*[\s\S]*?\*\/)/g, `<span class="tok-comment">$1</span>`);
    // strings
    out = out.replace(
      /("(?:(?:\\.)|[^"\\])*"|'(?:(?:\\.)|[^'\\])*'|`(?:(?:\\.)|[^`\\])*`)/g,
      `<span class="tok-string">$1</span>`
    );
    // keywords
    out = out.replace(
      /\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|try|catch|finally|throw|new|class|extends|import|from|export|default|await|async)\b/g,
      `<span class="tok-keyword">$1</span>`
    );
    // booleans/null
    out = out.replace(/\b(true|false)\b/g, `<span class="tok-boolean">$1</span>`);
    out = out.replace(/\b(null|undefined)\b/g, `<span class="tok-null">$1</span>`);
    // numbers
    out = out.replace(/\b(-?\d+(?:\.\d+)?)\b/g, `<span class="tok-number">$1</span>`);
    return out;
  }

  if (lang === "py") {
    let out = src;
    // comments
    out = out.replace(/(#.*$)/gm, `<span class="tok-comment">$1</span>`);
    // strings (basic)
    out = out.replace(
      /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:(?:\\.)|[^"\\])*"|'(?:(?:\\.)|[^'\\])*')/g,
      `<span class="tok-string">$1</span>`
    );
    // keywords
    out = out.replace(
      /\b(def|return|if|elif|else|for|while|break|continue|try|except|finally|raise|class|import|from|as|with|pass|lambda|yield|await|async)\b/g,
      `<span class="tok-keyword">$1</span>`
    );
    // booleans/none
    out = out.replace(/\b(True|False)\b/g, `<span class="tok-boolean">$1</span>`);
    out = out.replace(/\b(None)\b/g, `<span class="tok-null">$1</span>`);
    // numbers
    out = out.replace(/\b(-?\d+(?:\.\d+)?)\b/g, `<span class="tok-number">$1</span>`);
    return out;
  }

  // md/plain: no highlight, keep safe HTML
  return src;
}

// ─────────────────────────────────────────────
// Markdown rendering (safe, minimal; no external deps)
function isMarkdownExt(ext) {
  const e = String(ext || "").toLowerCase();
  return e === ".md" || e === ".markdown";
}

function safeLinkHref(href) {
  const h = String(href || "").trim();
  if (!h) return "";
  // allow http(s), mailto and relative paths
  if (/^(https?:\/\/|mailto:|\/|\.\/|\.\.\/)/i.test(h)) return h;
  return "";
}

function renderMarkdown(mdText) {
  // Escape everything first to prevent HTML injection, then apply a small subset of markdown.
  let s = escapeHtml(String(mdText || "")).replace(/\r\n/g, "\n");

  // fenced code blocks ```lang?\n...\n```
  s = s.replace(/```([a-zA-Z0-9_-]+)?\n([\s\S]*?)```/g, (m, lang, code) => {
    const cls = lang ? ` data-lang="${escapeHtml(lang)}"` : "";
    return `<pre class="mdCode"><code${cls}>${code}</code></pre>`;
  });

  // inline code
  s = s.replace(/`([^`\n]+)`/g, `<code class="mdInline">$1</code>`);

  // headings
  s = s.replace(/^###\s+(.+)$/gm, `<h3>$1</h3>`);
  s = s.replace(/^##\s+(.+)$/gm, `<h2>$1</h2>`);
  s = s.replace(/^#\s+(.+)$/gm, `<h1>$1</h1>`);

  // bold / italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, `<strong>$1</strong>`);
  s = s.replace(/\*([^*\n]+)\*/g, `<em>$1</em>`);

  // links [text](href)
  s = s.replace(/\[([^\]\n]+)\]\(([^)\n]+)\)/g, (m, text, href) => {
    const safe = safeLinkHref(href);
    if (!safe) return text;
    return `<a href="${escapeHtml(safe)}" target="_blank" rel="noreferrer">${text}</a>`;
  });

  // unordered lists: consecutive lines starting with - / * / +
  s = s.replace(/(?:^|\n)(?:\s*[-*+]\s+.+(?:\n|$))+/g, (block) => {
    const items = block
      .trim()
      .split("\n")
      .map((ln) => ln.replace(/^\s*[-*+]\s+/, "").trim())
      .filter(Boolean)
      .map((it) => `<li>${it}</li>`)
      .join("");
    return `\n<ul>${items}</ul>\n`;
  });

  // blockquote >
  s = s.replace(/^>\s?(.*)$/gm, `<blockquote>$1</blockquote>`);

  // hr
  s = s.replace(/^\s*(?:---|\*\*\*)\s*$/gm, `<hr/>`);

  // paragraphs: split by blank lines, keep block tags as-is
  const blocks = s.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  const html = blocks
    .map((b) => {
      if (/^(<h[1-3]>|<ul>|<pre |<pre>|<blockquote>|<hr\/>)/.test(b)) return b;
      return `<p>${b.replace(/\n/g, "<br/>")}</p>`;
    })
    .join("\n");

  return html || `<p class="mdEmpty">—</p>`;
}

function bringToFront(card) {
  fvZ += 1;
  card.style.zIndex = String(fvZ);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function makeFileCard({ absPath, relPath, ext, sizeBytes, content }) {
  const layer = fvLayer();
  if (!layer) return;

  // if already open, just bring front
  if (fvOpen.has(absPath)) {
    const existing = document.getElementById(fvOpen.get(absPath));
    if (existing) bringToFront(existing);
    return;
  }

  const id = "fv_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
  fvOpen.set(absPath, id);

  const card = document.createElement("div");
  card.className = "fvCard";
  card.id = id;

  // initial placement (staggered)
  const baseLeft = 40 + (fvOpen.size - 1) * 24;
  const baseTop = 60 + (fvOpen.size - 1) * 18;

  card.style.left = clamp(baseLeft, 10, window.innerWidth - 360) + "px";
  card.style.top = clamp(baseTop, 10, window.innerHeight - 260) + "px";
  card.style.zIndex = String(++fvZ);

  const iconId = fileTypeIconId(ext);
  const lang = guessLang(ext);
  const title = relPath || absPath;

  let current = String(content || "");
  let original = current;
  let editing = false;
  let mdRaw = false;

  const isMd = isMarkdownExt(ext);

  function renderViewer() {
    const body = card.querySelector("[data-body]");
    if (!body) return;

    if (isMd) {
      const mdEl = body.querySelector("[data-md]");
      const rawEl = body.querySelector("[data-rawbody]");
      if (mdEl) mdEl.innerHTML = renderMarkdown(current);
      if (rawEl) rawEl.innerHTML = `<code>${escapeHtml(current)}</code>`;
      if (mdEl) mdEl.style.display = mdRaw ? "none" : "";
      if (rawEl) rawEl.style.display = mdRaw ? "" : "none";
    } else {
      const codeEl = body.querySelector("[data-code]");
      if (codeEl) codeEl.innerHTML = highlight(current, lang);
    }

    const metaEl = card.querySelector("[data-meta]");
    if (metaEl) metaEl.textContent = `${String(ext || "").replace(".", "").toUpperCase() || "FILE"} · ${fmtBytes(sizeBytes)}`;
  }

  function setEditing(on) {
    editing = Boolean(on);
    const editor = card.querySelector("[data-editor]");
    const viewer = card.querySelector("[data-viewer]");
    const btnEdit = card.querySelector("[data-edit]");
    const btnSave = card.querySelector("[data-save]");
    const btnCancel = card.querySelector("[data-cancel]");
    const btnRaw = card.querySelector("[data-raw]");
    const btnClose = card.querySelector("[data-close]");
    const confirmBar = card.querySelector("[data-confirm]");

    card.dataset.editing = editing ? "1" : "0";
    if (!editing && confirmBar) confirmBar.style.display = "none";

    if (btnClose) btnClose.style.display = editing ? "none" : "";

    if (editor) {
      editor.style.display = editing ? "" : "none";
      if (editing) editor.value = current;
    }
    if (viewer) viewer.style.display = editing ? "none" : "";
    if (btnEdit) btnEdit.classList.toggle("active", editing);
    if (btnSave) btnSave.style.display = editing ? "" : "none";
    if (btnCancel) btnCancel.style.display = editing ? "" : "none";
    if (btnRaw) btnRaw.style.display = !editing ? "" : "none";
  }

  card.innerHTML = `
    <div class="fvHead" data-drag="1">
      <div class="fvHeadLeft">
        <span class="fvTypeIcon">
          <svg class="ico"><use href="#${iconId}"></use></svg>
        </span>
        <div class="fvTitle" title="${escapeHtml(title)}">${escapeHtml(title.split("/").pop() || title)}</div>
        <div class="fvMeta" data-meta="1">${escapeHtml(String(ext || "").replace(".", "").toUpperCase() || "FILE")} · ${escapeHtml(fmtBytes(sizeBytes))}</div>
      </div>
      <div class="fvHeadRight">
        <button class="fvBtn" data-edit="1" title="Edit">
          <svg class="ico"><use href="#icon-edit"></use></svg>
        </button>
        <button class="fvBtn" data-save="1" title="Save" style="display:none">
          <svg class="ico"><use href="#icon-save"></use></svg>
        </button>
        <button class="fvBtn" data-cancel="1" title="Cancel" style="display:none">
          <svg class="ico"><use href="#icon-x"></use></svg>
        </button>

        ${isMd ? `
          <button class="fvBtn" data-raw="1" title="Toggle raw / preview">
            <svg class="ico"><use href="#icon-raw"></use></svg>
          </button>
        ` : ``}

        <button class="fvBtn" data-fs="1" title="Fullscreen">
          <svg class="ico"><use href="#icon-fullscreen"></use></svg>
        </button>

        <button class="fvBtn" data-close="1" title="Close">
          <svg class="ico"><use href="#icon-x"></use></svg>
        </button>
      </div>
    </div>

    <div class="fvConfirmBar" data-confirm="1" style="display:none">
      <div class="fvConfirmText">Discard unsaved changes?</div>
      <div class="fvConfirmActions">
        <button class="fvMiniBtn danger" data-discard="1">Discard</button>
        <button class="fvMiniBtn" data-keep="1">Keep editing</button>
      </div>
    </div>

    <div class="fvBody" data-body="1">
      <div class="fvViewer" data-viewer="1">
        ${
          isMd
            ? `<div class="fvMd" data-md="1">${renderMarkdown(current)}</div>
               <pre class="fvCode fvCodeRaw" data-rawbody="1" style="display:none"><code>${escapeHtml(current)}</code></pre>`
            : `<pre class="fvCode"><code data-code="1">${highlight(current, lang)}</code></pre>`
        }
      </div>

      <textarea class="fvEditor" data-editor="1" spellcheck="false" style="display:none"></textarea>
    </div>
  `;

  // close
  card.querySelector("[data-close]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    fvOpen.delete(absPath);
    card.remove();
    _syncFvFullscreenState();
  });

  // markdown: raw/preview toggle
  const rawBtn = card.querySelector("[data-raw]");
  if (rawBtn) {
    rawBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (editing) return;
      mdRaw = !mdRaw;
      const mdEl = card.querySelector("[data-md]");
      const rawEl = card.querySelector("[data-rawbody]");
      if (mdEl) mdEl.style.display = mdRaw ? "none" : "";
      if (rawEl) rawEl.style.display = mdRaw ? "" : "none";
      rawBtn.classList.toggle("active", mdRaw);
    });
  }

  // fullscreen toggle
  const fsBtn = card.querySelector("[data-fs]");
  if (fsBtn) {
    fsBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      bringToFront(card);

      const isFs = !card.classList.contains("fvFullscreen");
      if (isFs) {
        // save current rect
        card.dataset.prevLeft = card.style.left || "";
        card.dataset.prevTop = card.style.top || "";
        card.dataset.prevWidth = card.style.width || "";
        card.dataset.prevHeight = card.style.height || "";
        card.classList.add("fvFullscreen");
        _syncFvFullscreenState();
      } else {
        card.classList.remove("fvFullscreen");
        _syncFvFullscreenState();
        // restore rect
        card.style.left = card.dataset.prevLeft || "";
        card.style.top = card.dataset.prevTop || "";
        card.style.width = card.dataset.prevWidth || "";
        card.style.height = card.dataset.prevHeight || "";
      }
    });
  }


  // edit button
  card.querySelector("[data-edit]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hideDiscardConfirm();
    setEditing(!editing);
  });

  function isDirty() {
    const editor = card.querySelector("[data-editor]");
    const val = editor ? String(editor.value ?? "") : current;
    return val !== original;
  }

  function showDiscardConfirm() {
    const bar = card.querySelector("[data-confirm]");
    if (!bar) return false;
    bar.style.display = "";
    const keep = bar.querySelector("[data-keep]");
    const discard = bar.querySelector("[data-discard]");
    keep?.focus?.();
    return true;
  }

  function hideDiscardConfirm() {
    const bar = card.querySelector("[data-confirm]");
    if (bar) bar.style.display = "none";
  }

  function discardAndExitEdit() {
    hideDiscardConfirm();
    current = original;
    setEditing(false);
    renderViewer();
  }

  function cancelEditWithConfirm() {
    if (!editing) return;
    if (isDirty()) {
      showDiscardConfirm();
      return;
    }
    discardAndExitEdit();
  }

  // cancel edit
  card.querySelector("[data-cancel]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    cancelEditWithConfirm();
  });

  // confirm bar actions
  card.querySelector("[data-keep]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    hideDiscardConfirm();
    // keep editing
  });

  card.querySelector("[data-discard]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    discardAndExitEdit();
  });

  // save edit
  card.querySelector("[data-save]")?.addEventListener("click", async (e) => {
    e.stopPropagation();

    const editor = card.querySelector("[data-editor]");
    const next = editor ? String(editor.value ?? "") : current;

    const res = await ipcRenderer.invoke("file:write", absPath, next);
    if (!res || !res.ok) {
      addLog(`[FILE_SAVE] ${res?.error || "Unable to save file."}`);
      return;
    }

    current = next;
    original = next;
    sizeBytes = res.meta?.sizeBytes ?? sizeBytes;

    setEditing(false);
    renderViewer();
    const titleEl = card.querySelector(".fvTitle");
    if (titleEl) {
      const baseName = (res.meta?.relPath || relPath || absPath).split("/").pop() || (res.meta?.relPath || relPath || absPath);
      titleEl.textContent = baseName;
    }
    addLog(`[FILE_SAVE] Saved ${res.meta?.relPath || relPath || absPath}`);
  });

  // keep current in sync while typing (for live feel; doesn't change flow)
  card.querySelector("[data-editor]")?.addEventListener("input", (e) => {
    if (!editing) return;
    current = String(e.target.value ?? "");

    const titleEl = card.querySelector(".fvTitle");
    if (titleEl) {
      const baseName = (relPath || absPath).split("/").pop() || (relPath || absPath);
      const dirty = isDirty();
      titleEl.textContent = dirty ? baseName + " *" : baseName;
    }
  });

  // expose cancel for global ESC handling
  card._cancelEditWithConfirm = cancelEditWithConfirm;

  // focus on click
  card.addEventListener("mousedown", () => bringToFront(card));

  // drag logic (header only)
  const head = card.querySelector("[data-drag]");
  let dragging = false;
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;

  head?.addEventListener("mousedown", (e) => {
    // ignore if user clicked buttons
    if (
      e.target.closest &&
      (e.target.closest("[data-close]") ||
        e.target.closest("[data-raw]") ||
        e.target.closest("[data-edit]") ||
        e.target.closest("[data-save]") ||
        e.target.closest("[data-cancel]") ||
        e.target.closest("[data-fs]"))
    )
      return;

    dragging = true;
    bringToFront(card);

    const rect = card.getBoundingClientRect();
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;

    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;

    const dx = e.clientX - startX;
    const dy = e.clientY - startY;

    const nextLeft = clamp(startLeft + dx, 8, window.innerWidth - 120);
    const nextTop = clamp(startTop + dy, 8, window.innerHeight - 60);

    card.style.left = nextLeft + "px";
    card.style.top = nextTop + "px";
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });

  layer.appendChild(card);

  // initial render
  setEditing(false);
  renderViewer();
}
function syncExpandedIdsFromPaths(tree){
  try{
    expanded.clear();
    const walk = (n)=>{
      if(!n) return;
      if(n.isDir && expandedPaths.has(n.absPath)) expanded.add(n.id);
      if(n.children && n.children.length) n.children.forEach(walk);
    };
    walk(tree);
  }catch{}
}

function flattenTree(node, depth, out, ignoredSet) {
  const hasChildren = node.isDir && node.children && node.children.length > 0;
  out.push({
    id: node.id,
    name: node.name,
    absPath: node.absPath,
    isDir: node.isDir,
    hasChildren,
    depth,
    ignored: ignoredSet.has(node.absPath),
  });

  if (hasChildren && expanded.has(node.id)) {
    for (const ch of node.children) {
      flattenTree(ch, depth + 1, out, ignoredSet);
    }
  }
}

function addLog(line) {
  const box = el("logBox");
  box.textContent += line + "\n";
  box.scrollTop = box.scrollHeight;
}

function setPipelineText(obj) {
  el("pipelineText").value = obj ? JSON.stringify(obj, null, 2) : "";
}

function renderManifest(manifest) {
  if (!manifest) {
    el("toolNameLine").textContent = "—";
    el("toolVerLine").textContent = "—";
    el("toolDescLine").textContent = "—";
    el("howToList").innerHTML = `<div class="hint">(no manifest loaded)</div>`;
    el("pipelineExample").textContent = "(none)";
    return;
  }

  el("toolNameLine").textContent = manifest.name || manifest.tool_id || "—";
  el("toolVerLine").textContent = manifest.version || "—";
  el("toolDescLine").textContent = manifest.description || "—";

  const how = manifest.help?.how_to || [];
  const list = el("howToList");
  list.innerHTML = "";
  if (Array.isArray(how) && how.length) {
    for (const it of how) {
      const div = document.createElement("div");
      div.className = "docItem";
      div.textContent = "• " + it;
      list.appendChild(div);
    }
  } else {
    list.innerHTML = `<div class="hint">(no help.how_to in manifest)</div>`;
  }

  const example = manifest.help?.examples?.["pipeline.json"] || manifest.help?.examples?.pipeline || null;
  el("pipelineExample").textContent = example ? JSON.stringify(example, null, 2) : "(none)";
}

function render(snapshot) {
  lastSnapshot = snapshot;

  el("projectPath").textContent = snapshot.projectPath || "No folder opened";
  el("itemsCount").textContent = `${snapshot.stats.items} items`;
  el("statusLine").textContent = snapshot.status || "Ready.";

  el("stats").textContent =
    `Folders: ${snapshot.stats.folders} · Files: ${snapshot.stats.files} · Ignored: ${
      snapshot.stats.ignoredFiles + snapshot.stats.ignoredFolders
    }`;

  // Tool section
  const runner = snapshot.patch?.runnerPath || null;
  const mpath = snapshot.patch?.manifestPath || null;
  const manifest = snapshot.patch?.manifest || null;

  el("runnerLine").textContent = runner || "(not set)";
  el("manifestLine").textContent = mpath || "(not found)";
  renderManifest(manifest);

  // Patch section state
  currentPipelinePath = snapshot.patch?.lastPipelinePath || currentPipelinePath;
  el("pipelinePathLine").textContent = `Pipeline: ${currentPipelinePath || "(not saved)"}`;

  const selected = snapshot.patch?.selectedRws || [];
  el("rwMeta").textContent = `${selected.length} selected`;

  const rwList = el("rwList");
  rwList.innerHTML = "";
  if (selected.length) {
    for (const p of selected) {
      const div = document.createElement("div");
      div.className = "rwItem";
      div.textContent = p;
      rwList.appendChild(div);
    }
  } else {
    const div = document.createElement("div");
    div.className = "rwEmpty";
    div.textContent = "(none)";
    rwList.appendChild(div);
  }

  const rejected = snapshot.patch?.rejectedRws || [];
  const warn = el("rwWarn");
  if (rejected.length) {
    warn.style.display = "block";
    warn.textContent = `Bloqueados (fora do root): ${rejected.length}`;
  } else {
    warn.style.display = "none";
    warn.textContent = "";
  }

  const hasProject = Boolean(snapshot.projectPath);
  const hasRunnerAndManifest = Boolean(runner) && Boolean(manifest);

  el("btnPickRw").disabled = !hasProject;
  el("btnClearRw").disabled = !hasProject;
  el("btnSavePipeline").disabled = !hasProject;

  el("btnRunPlan").disabled = !hasProject || !hasRunnerAndManifest;
  el("btnRunApply").disabled = !hasProject || !hasRunnerAndManifest;

  el("btnStopPatch").disabled = !snapshot.patch?.running;

// PATCH: sync patch busy state from snapshot
try{
  const running = !!snapshot.patch?.running;
  if(running !== _patchBusy) setPatchBusy(running);
}catch{}


  // File list
  const ignoredSet = new Set(snapshot.ignored || []);
  const list = el("fileList");
  list.innerHTML = "";

  if (!snapshot.tree) return;

  const rows = [];
  for (const ch of snapshot.tree.children || []) {
    flattenTree(ch, 0, rows, ignoredSet);
  }

  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "row" + (r.id === selectedId ? " selected" : "") + (r.ignored ? " ignored" : "");

    const indentPx = r.depth * 16;

    const caret = r.isDir
      ? `<span class="caret" data-caret="1" title="${expanded.has(r.id) ? "Collapse" : "Expand"}">
          ${expanded.has(r.id) ? svgUse("icon-chevron-down") : svgUse("icon-chevron-right")}
        </span>`
      : `<span class="caret" style="visibility:hidden">${svgUse("icon-chevron-right")}</span>`;

    const icon = r.isDir ? svgUse("icon-folder") : svgUse("icon-file");
    const eyeIcon = r.ignored ? "icon-eye-off" : "icon-eye";

    // file view button (only for files)
    const viewBtn = !r.isDir
      ? `<button class="actionBtn" data-view="1" title="View file">${svgUse("icon-file-view")}</button>`
      : ``;

    row.innerHTML = `
      <div class="rowLeft" style="padding-left:${indentPx}px">
        ${caret}
        <span class="fileIco">${icon}</span>
        <div class="name" title="${r.name}">${r.name}</div>
        <div class="actions">
          ${viewBtn}
          <button class="actionBtn" data-eye="1" title="${r.ignored ? "Unignore" : "Ignore"}">
            ${svgUse(eyeIcon)}
          </button>
          ${r.ignored ? `<span class="badge">Ignored</span>` : ``}
        </div>
      </div>
    `;

    row.addEventListener("click", (e) => {
      const target = e.target;
      if (
        target.closest &&
        (target.closest("[data-caret]") || target.closest("[data-eye]") || target.closest("[data-view]"))
      )
        return;
      selectedId = r.id;
      render(snapshot);
    });

    row.querySelector("[data-caret]")?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!r.isDir) return;
      if (expanded.has(r.id)) expanded.delete(r.id);
      else expanded.add(r.id);
      render(snapshot);
    });

    row.querySelector("[data-eye]")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      await ipcRenderer.invoke("tree:toggleIgnored", r.absPath);
    });

    row.querySelector("[data-view]")?.addEventListener("click", async (e) => {
      e.stopPropagation();
      const res = await ipcRenderer.invoke("file:read", r.absPath);
      if (!res || !res.ok) {
        addLog(`[FILE_VIEW] ${res?.error || "Unable to read file."}`);
        return;
      }
      makeFileCard({
        absPath: r.absPath,
        relPath: res.meta?.relPath || r.name,
        ext: res.meta?.ext || "",
        sizeBytes: res.meta?.sizeBytes || 0,
        content: res.content || "",
      });
    });

    row.addEventListener("dblclick", async (e) => {
      const target = e.target;
      if (
        target.closest &&
        (target.closest("[data-caret]") || target.closest("[data-eye]") || target.closest("[data-view]"))
      )
        return;

      // comportamento atual: duplo clique alterna ignore/unignore
      await ipcRenderer.invoke("tree:toggleIgnored", r.absPath);
    });

    list.appendChild(row);
  }
}

// ─────────────────────────────────────────────
// Wire buttons / UI actions
function bind() {
  setTabs();

  el("btnOpen").addEventListener("click", async () => {
    await ipcRenderer.invoke("project:open");
  });

  el("btnRefreshFiles").addEventListener("click", async () => {
    const b = el("btnRefreshFiles");
    if (b?.classList?.contains("busy")) return;

    try {
      b?.classList?.add("busy");
      showToast("Refreshing files…", { type: "info", ttl: 1600 });

      const res = await ipcRenderer.invoke("project:refresh");

      // best-effort success detection (handler may return snapshot or nothing)
      if (res && res.ok === false) {
        showToast("Refresh failed.", { type: "error", ttl: 3600 });
      } else {
        showToast("Files refreshed.", { type: "success", ttl: 1800 });
      }
    } catch (e) {
      showToast("Refresh failed. Check Logs.", { type: "error", ttl: 4200 });
    } finally {
      b?.classList?.remove("busy");
    }
  });

  el("btnHelp").addEventListener("click", async () => {
    await ipcRenderer.invoke("ui:help");
  });

  el("btnClearIgnored").addEventListener("click", async () => {
    await ipcRenderer.invoke("tree:clearIgnored");
  });

  el("btnExportTxt").addEventListener("click", async () => {
    showToast("Exporting TXT…", { type: "info", ttl: 1800 });
    await ipcRenderer.invoke("export:txt");
  });

  el("btnExportJson").addEventListener("click", async () => {
    showToast("Exporting JSON…", { type: "info", ttl: 1800 });
    await ipcRenderer.invoke("export:json");
  });

  el("btnCopyLogs").addEventListener("click", async () => {
    showToast("Logs copied.", { type: "success", ttl: 1600 });
    await ipcRenderer.invoke("logs:copy");
  });

  el("btnClearLogs").addEventListener("click", async () => {
    await ipcRenderer.invoke("logs:clear");
  });

  // Patch tools
  el("btnPickRunner").addEventListener("click", async () => {
    await ipcRenderer.invoke("patch:pickRunner");
  });

  el("btnReloadManifest").addEventListener("click", async () => {
    await ipcRenderer.invoke("patch:reloadManifest");
  });

  el("btnPickRw").addEventListener("click", async () => {
    const res = await ipcRenderer.invoke("patch:pickRw");
    // auto-generate pipeline from current selection
    const list = res?.valid || [];
    if (Array.isArray(list) && list.length) {
      const pipelineObj = await ipcRenderer.invoke("patch:generatePipeline", list);
      setPipelineText(pipelineObj);
    }
  });

  el("btnClearRw").addEventListener("click", async () => {
    // limpar seleção só no renderer (mantém simples)
    if (!lastSnapshot) return;
    lastSnapshot.patch.selectedRws = [];
    lastSnapshot.patch.rejectedRws = [];
    render(lastSnapshot);
    setPipelineText(null);
    currentPipelinePath = null;
    el("pipelinePathLine").textContent = `Pipeline: (not saved)`;
  });

  el("btnSavePipeline").addEventListener("click", async () => {
    try {
      const outPath = await ipcRenderer.invoke("patch:savePipeline", {
        pipelineText: el("pipelineText").value,
      });
      if (outPath) {
        currentPipelinePath = outPath;
        el("pipelinePathLine").textContent = `Pipeline: ${currentPipelinePath}`;
        showToast("Pipeline saved.", { type: "success", ttl: 2200 });
      }
    } catch (e) {
      addLog(`[PIPELINE_SAVE] ${e.message || e}`);
    }
  });

  el("btnRunPlan").addEventListener("click", async () => {
    setPatchBusy(true, "plan");

    showToast("Running Plan…", { type: "info", ttl: 1600 });
    try {
  await ipcRenderer.invoke("patch:runPipeline", { mode: "plan", pipelinePath: currentPipelinePath });
} catch (e) {
  setPatchBusy(false);
  throw e;
}
  });

  el("btnRunApply").addEventListener("click", async () => {
    setPatchBusy(true, "apply");

    showToast("Running Apply…", { type: "info", ttl: 1600 });
    try {
  await ipcRenderer.invoke("patch:runPipeline", { mode: "apply", pipelinePath: currentPipelinePath });
} catch (e) {
  setPatchBusy(false);
  throw e;
}
  });

  el("btnStopPatch").addEventListener("click", async () => {
    showToast("Stopping patch…", { type: "warn", ttl: 1800 });
    await ipcRenderer.invoke("patch:stop");
  });

  // Keyboard: ESC behavior
  // - if topmost card is editing: ask to discard (visual confirm bar)
  // - otherwise: close topmost card
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const layer = fvLayer();
    if (!layer) return;

    const cards = Array.from(layer.querySelectorAll(".fvCard"));
    if (!cards.length) return;

    // find topmost by z-index
    let top = cards[0];
    let topZ = Number(top.style.zIndex || 0);
    for (const c of cards) {
      const z = Number(c.style.zIndex || 0);
      if (z >= topZ) {
        topZ = z;
        top = c;
      }
    }

    // if editing, ESC acts like Cancel Edit (with confirm bar)
    if (top?.dataset?.editing === "1" && typeof top._cancelEditWithConfirm === "function") {
      e.preventDefault();
      top._cancelEditWithConfirm();
      return;
    }

    // otherwise close topmost card
    for (const [abs, cid] of fvOpen.entries()) {
      if (cid === top.id) {
        fvOpen.delete(abs);
        break;
      }
    }
    top.remove();
    _syncFvFullscreenState();
  });
}

// ─────────────────────────────────────────────
// IPC events
ipcRenderer.on("state:update", (_, snapshot) => {
  render(snapshot);
});

ipcRenderer.on("log:append", (_, line) => {
  addLog(line);
  toastFromLog(line);
});

ipcRenderer.on("log:reset", () => {
  el("logBox").textContent = "";
});

// Auto-refresh watcher event (from main process)
ipcRenderer.on("watcher:changed", (_ev, payload) => {
  // payload: { reason }
  _scheduleAutoRefresh(payload?.reason || "watch");
});


// bootstrap
bind();
ipcRenderer.invoke("ui:refresh");


// topbar height -> CSS var (for fullscreen card positioning)
function updateTopbarH() {
  const tb = document.querySelector(".topbar");
  if (!tb) return;
  document.documentElement.style.setProperty("--topbarH", tb.offsetHeight + "px");
}
window.addEventListener("resize", updateTopbarH);
updateTopbarH();
_syncFvFullscreenState();


// PATCH: sync fullscreen UI state (used to hide underlying layout while fvFullscreen is active)
function _syncFvFullscreenState(){
  try{
    const anyFs = !!document.querySelector(".fvCard.fvFullscreen");
    document.body.classList.toggle("has-fv-fullscreen", anyFs);
  }catch{}
}


// ─────────────────────────────────────────────
// PATCH: Patch execution UI state (disable Run buttons while running)
let _patchBusy = false;
let _patchBusyLabel = "";

function _setBtnBusy(btn, busy, label){
  if(!btn) return;
  if(busy){
    if(!btn.dataset.origText) btn.dataset.origText = btn.textContent || "";
    btn.textContent = label ? `${label}…` : (btn.dataset.origText || "Running…");
    btn.classList.add("busy");
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
  }else{
    const orig = btn.dataset.origText;
    if(orig) btn.textContent = orig;
    btn.classList.remove("busy");
    btn.disabled = false;
    btn.removeAttribute("aria-busy");
  }
}

function setPatchBusy(busy, label){
  _patchBusy = !!busy;
  _patchBusyLabel = String(label || "");

  // Only touch buttons here (render() will still apply project/runner gating)
  const bPlan = el("btnRunPlan");
  const bApply = el("btnRunApply");

  if(_patchBusy){
    _setBtnBusy(bPlan, true, "Running Plan");
    _setBtnBusy(bApply, true, "Running Apply");
  }else{
    _setBtnBusy(bPlan, false);
    _setBtnBusy(bApply, false);
  }
}


// PATCH: open Logs tab (used by toast click)
function _openLogsTab(){
  try{
    const btn = document.querySelector('.tab[data-tab="logs"]');
    if(btn) btn.click();
  }catch{}
}

// PATCH: toast grouping state (prevent spam by merging duplicates)
const _toastGroup = new Map(); // key -> { el, count, lastTs, _t }
function _toastKey(type, msg){
  return String(type||"info") + "|" + String(msg||"");
}
