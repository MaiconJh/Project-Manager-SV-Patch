// @context: export-preset-file save-dialog open-dialog apply-rehydrate feedback ui-diagnostics preset-ui-fix safe-bind.
/*
PM-SV-PATCH META
Version: pm-svpatch-ui@2026.02.11-r1
Last-Edited: 2026-02-11
Contains: UI shell, file tree, file view cards (view/edit/markdown/raw/fullscreen), toasts, patch controls UI.
Implemented in this version: (1) Refresh SVG icon fix (centered, consistent). (2) Refresh button alignment/feedback CSS (no logic changes).
*/
const { ipcRenderer } = require("electron");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { TextDecoder } = require("util");
const { DEFAULT_IGNORE_EXTS } = require("./config");
const el = (id) => document.getElementById(id);

const __PM_UI_DEV__ = !process?.env || process.env.NODE_ENV !== "production";
const __PM_UI_TRACE_CLICKS__ = __PM_UI_DEV__ && process?.env?.PM_UI_TRACE_CLICKS === "1";
const __UI_BIND_EXPECTED_BUTTON_IDS__ = [
  "btnOpen",
  "btnRefreshFiles",
  "btnHelp",
  "btnClearIgnored",
  "btnExportPrimary",
  "btnCopyLogs",
  "btnClearLogs",
  "btnPickRunner",
  "btnBuildManifest",
  "btnSavePipeline",
  "btnRunPlan",
  "btnRunApply",
  "btnStopPatch",
  "btnPresetSaveFile",
  "btnPresetImportFile",
];
const __UI_BIND_METRICS__ = {
  expected: new Set(__UI_BIND_EXPECTED_BUTTON_IDS__),
  wired: new Set(),
  missingDom: new Set(),
  missingHandler: new Set(),
};
function _uiDevLog(msg, err) {
  try { if (typeof addLog === "function") addLog(`[UI] ${msg}${err ? ` :: ${err?.message || err}` : ""}`); } catch {}
  try { if (err) console.error(`[UI] ${msg}`, err); else console.warn(`[UI] ${msg}`); } catch {}
}
function _reportUiBindingIssue(message) {
  try { console.error(`[UI] ${message}`); } catch {}
  try { showToast(message, { type: "error", ttl: 2400 }); } catch {}
}
function _bindClickSafe(id, handler, opts = {}) {
  const node = el(id);
  if (!node) {
    if (opts.required !== false) {
      __UI_BIND_METRICS__.missingDom.add(id);
      _reportUiBindingIssue(`Missing UI element: #${id}`);
    }
    return;
  }
  if (typeof handler !== "function") {
    __UI_BIND_METRICS__.missingHandler.add(id);
    _reportUiBindingIssue(`Missing click handler: #${id}`);
    return;
  }
  __UI_BIND_METRICS__.wired.add(id);
  node.addEventListener("click", async (ev) => {
    try {
      await handler(ev);
    } catch (e) {
      _reportUiBindingIssue(`Action failed (${id})`);
      _uiDevLog(`click handler failed: #${id}`, e);
      showToast(`Action failed (${id})`, { type: "error", ttl: 2600 });
    }
  });
}

function _reportUiBindHealth() {
  if (!__PM_UI_DEV__) return;
  try {
    const expected = __UI_BIND_METRICS__.expected;
    for (const id of expected) {
      if (!__UI_BIND_METRICS__.wired.has(id) && !__UI_BIND_METRICS__.missingDom.has(id)) {
        __UI_BIND_METRICS__.missingHandler.add(id);
      }
    }
    const wiredCount = __UI_BIND_METRICS__.wired.size;
    const missingCount = __UI_BIND_METRICS__.missingDom.size + __UI_BIND_METRICS__.missingHandler.size;
    console.log(`[UI] bind complete: ${wiredCount} buttons wired, ${missingCount} missing`);
    if (__UI_BIND_METRICS__.missingDom.size) {
      console.error(`[UI] bind missing DOM IDs: ${Array.from(__UI_BIND_METRICS__.missingDom).join(", ")}`);
    }
    if (__UI_BIND_METRICS__.missingHandler.size) {
      console.error(`[UI] bind missing handlers: ${Array.from(__UI_BIND_METRICS__.missingHandler).join(", ")}`);
    }
  } catch (e) {
    _uiDevLog("bind health report failed", e);
  }
}

const expanded = new Set();
const expandedPaths = new Set(); // absPath set to preserve expanded state across refreshes
let selectedId = null;

let filesSearchQuery = "";
let filesSearchDebounceTimer = null;

let currentPipelinePath = null;
let lastSnapshot = null;
let _applyDiffPreviewNonce = 0;
const _exportSelectionState = {
  selected: new Set(),
  selectedMode: "all", // all | selected
};
const _exportSelectionFile = ".pm_sv_export_selection.json";
const _exportSizeState = {
  status: "idle", // idle | loading | ready | error
  bytes: null,
  lastStableBytes: null,
  key: "",
  token: 0,
  debounceTimer: null,
  cache: new Map(),
};
const _exportUi = {
  type: "txt", // txt | json
  contentLevel: "standard", // compact | standard | full (standard/full map to profile full)
  options: {
    treeHeader: true,
    ignoredSummary: true,
    hashes: false,
    sortDet: true,
  },
};
const _exportPresetState = {
  applying: false,
  applyToken: 0,
  lastPresetPath: "",
  lastHealth: "none", // none | ok | partial | broken
  feedbackTimer: null,
};

const _applyDiffState = {
  open: false,
  busy: false,
  preview: null,
  files: [],
  filtered: [],
  selectedPath: "",
};

// File list virtualization state (keeps DOM small on large trees)
const _fileListVirtual = {
  overscan: 10,
  rowHeight: 40,
  scrollRAF: 0,
  resizeRAF: 0,
  bound: false,
};
let _fileRowsCache = [];
let _fileRowsSnapshot = null;

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
      _markPresetRefreshCycle();
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
  let _lineNumberTimer = null;
  let _findOpen = false;
  let _findMatches = [];
  let _findIndex = -1;
  let _findDebounceTimer = null;
  let _findBuildToken = 0;
  let _findOverlayCacheKey = "";
  let _findTypingTimer = null;
  const _findState = {
    isOpen: false,
    matches: [],
    activeIndex: -1,
    total: 0,
    buildToken: 0,
    lastQuery: "",
  };
  let _lineEnding = /\r\n/.test(current) ? "CRLF" : "LF";
  const _encoding = "UTF-8";

  const isMd = isMarkdownExt(ext);

  function updateLineNumbers(textarea, gutterPre) {
    if (!textarea || !gutterPre) return;
    const text = String(textarea.value ?? "");
    const lines = text.split("\n").length || 1;
    let out = "";
    for (let i = 1; i <= lines; i++) {
      out += i;
      if (i < lines) out += "\n";
    }
    gutterPre.textContent = out;
  }

  function updateViewerLineNumbers(text, gutterPre) {
    if (!gutterPre) return;
    const src = String(text ?? "");
    const lines = src.split(/\r?\n/).length || 1;
    let out = "";
    for (let i = 1; i <= lines; i++) {
      out += i;
      if (i < lines) out += "\n";
    }
    gutterPre.textContent = out;
  }

  function scheduleLineNumbersRefresh(textarea, gutterPre) {
    if (_lineNumberTimer) clearTimeout(_lineNumberTimer);
    _lineNumberTimer = setTimeout(() => updateLineNumbers(textarea, gutterPre), 50);
  }

  function syncEditorGutterScroll(textarea, gutter) {
    if (!textarea || !gutter) return;
    gutter.scrollTop = textarea.scrollTop;
  }

  function openFindBar(cardEl) {
    const findBar = cardEl?.querySelector("[data-findbar]");
    const findInput = cardEl?.querySelector("[data-find-input]");
    const editWrap = cardEl?.querySelector("[data-edit-wrap]");
    if (!findBar || !findInput || !editWrap || !editing) return;
    _findOpen = true;
    _findState.isOpen = true;
    cardEl.dataset.findOpen = "1";
    findBar.hidden = false;
    editWrap.classList.add("find-open");
    findInput.focus();
    findInput.select();
    _syncFindStatus(cardEl);
  }

  function closeFindBar(cardEl, focusEditor = false) {
    const findBar = cardEl?.querySelector("[data-findbar]");
    const editWrap = cardEl?.querySelector("[data-edit-wrap]");
    const editor = cardEl?.querySelector("[data-editor]");
    const findStatus = cardEl?.querySelector("[data-find-status]");
    const overlay = cardEl?.querySelector("[data-find-overlay]");
    const overlayContent = cardEl?.querySelector("[data-find-overlay-content]");
    if (_findDebounceTimer) clearTimeout(_findDebounceTimer);
    if (_findTypingTimer) clearTimeout(_findTypingTimer);
    _findBuildToken += 1;
    _findState.buildToken = _findBuildToken;
    _findOpen = false;
    _findState.isOpen = false;
    _findMatches = [];
    _findState.matches = [];
    _findIndex = -1;
    _findState.activeIndex = -1;
    _findState.total = 0;
    _findState.lastQuery = "";
    _findOverlayCacheKey = "";
    if (cardEl) cardEl.dataset.findOpen = "0";
    if (findBar) findBar.hidden = true;
    if (editWrap) editWrap.classList.remove("find-open");
    if (overlay) {
      overlay.hidden = true;
      overlay.scrollTop = 0;
      overlay.scrollLeft = 0;
    }
    if (overlayContent) overlayContent.innerHTML = "";
    if (findStatus) findStatus.textContent = "0 / 0";
    if (focusEditor && editor) editor.focus();
  }

  function _escapeRegExp(s) {
    return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function _escapeHtmlLite(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function _syncFindStatus(cardEl) {
    const status = cardEl?.querySelector("[data-find-status]");
    if (!status) return;
    if (!_findState.isOpen) {
      status.textContent = "0 / 0";
      return;
    }
    const total = _findState.total;
    if (!total) {
      status.textContent = "0 / 0";
      return;
    }
    status.textContent = `${_findState.activeIndex + 1} / ${total}`;
  }

  function _getFindOptions(cardEl) {
    const matchCase = Boolean(cardEl?.querySelector("[data-find-case]")?.checked);
    const wholeWord = Boolean(cardEl?.querySelector("[data-find-word]")?.checked);
    return { matchCase, wholeWord };
  }

  function _buildFindRegex(needleRaw, opts) {
    if (!needleRaw) return null;
    const src = opts.wholeWord ? `\\b${_escapeRegExp(needleRaw)}\\b` : _escapeRegExp(needleRaw);
    const flags = opts.matchCase ? "g" : "gi";
    return new RegExp(src, flags);
  }

  function _scrollFindOverlayWithEditor(cardEl) {
    const editor = cardEl?.querySelector("[data-editor]");
    const overlay = cardEl?.querySelector("[data-find-overlay]");
    if (!editor || !overlay) return;
    overlay.scrollTop = editor.scrollTop;
    overlay.scrollLeft = editor.scrollLeft;
  }

  function _findBarHasFocus(cardEl) {
    const findBar = cardEl?.querySelector("[data-findbar]");
    const ae = document.activeElement;
    return Boolean(findBar && ae && findBar.contains(ae));
  }

  function _scrollEditorToMatch(cardEl, match) {
    const editor = cardEl?.querySelector("[data-editor]");
    if (!editor || !match) return;
    const txt = String(editor.value || "").slice(0, Math.max(0, match.start));
    const lineIndex = txt.split("\n").length - 1;
    const cs = window.getComputedStyle(editor);
    const lineHeight = Number.parseFloat(cs.lineHeight) || 18;
    const padTop = Number.parseFloat(cs.paddingTop) || 0;
    const targetTop = padTop + (lineIndex * lineHeight);
    const nextTop = clamp(
      Math.round(targetTop - (editor.clientHeight / 2) + (lineHeight / 2)),
      0,
      Math.max(0, editor.scrollHeight - editor.clientHeight)
    );
    if (Math.abs((editor.scrollTop || 0) - nextTop) > 1) editor.scrollTop = nextTop;
    _scrollFindOverlayWithEditor(cardEl);
  }

  function _computeFindMatches(text, needleRaw, opts, tokenHint) {
    const out = [];
    if (!needleRaw) return out;
    const re = _buildFindRegex(needleRaw, opts);
    if (!re) return out;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (tokenHint !== _findBuildToken) return null;
      const start = m.index;
      const len = Math.max(1, String(m[0] || "").length);
      out.push({ start, end: start + len });
      if (len === 0) re.lastIndex += 1;
    }
    return out;
  }

  function _renderFindOverlay(cardEl, text, needleRaw, opts) {
    const overlay = cardEl?.querySelector("[data-find-overlay]");
    const overlayContent = cardEl?.querySelector("[data-find-overlay-content]");
    if (!overlay || !overlayContent) return;
    if (!_findState.total || !_findState.isOpen || !needleRaw) {
      overlay.hidden = true;
      overlayContent.innerHTML = "";
      _findOverlayCacheKey = "";
      return;
    }
    const cacheKey = `${needleRaw}::${opts.matchCase ? 1 : 0}::${opts.wholeWord ? 1 : 0}::${_findState.activeIndex}::${text.length}`;
    if (_findOverlayCacheKey === cacheKey) {
      overlay.hidden = false;
      return;
    }
    overlay.hidden = false;
    const markRe = _buildFindRegex(needleRaw, opts);
    if (!markRe) return;
    let activeCount = -1;
    overlayContent.innerHTML = _escapeHtmlLite(text).replace(markRe, (m0) => {
      activeCount += 1;
      const activeCls = activeCount === _findState.activeIndex ? " findMatchActive" : "";
      return `<mark class="findMatch${activeCls}">${_escapeHtmlLite(m0)}</mark>`;
    });
    _findOverlayCacheKey = cacheKey;
  }

  function _rebuildFindMatches(cardEl, tokenHint = _findBuildToken) {
    const editor = cardEl?.querySelector("[data-editor]");
    const findInput = cardEl?.querySelector("[data-find-input]");
    const overlay = cardEl?.querySelector("[data-find-overlay]");
    const overlayContent = cardEl?.querySelector("[data-find-overlay-content]");
    if (!editor || !findInput || !overlay || !overlayContent) return;

    const text = String(editor.value || "");
    const needleRaw = String(findInput.value || "");
    const opts = _getFindOptions(cardEl);
    if (_findTypingTimer && _findBarHasFocus(cardEl)) return;
    _findState.lastQuery = needleRaw;

    _findMatches = [];
    _findIndex = -1;
    _findState.matches = [];
    _findState.activeIndex = -1;
    _findState.total = 0;

    if (!_findOpen || !needleRaw) {
      _renderFindOverlay(cardEl, text, "", opts);
      _syncFindStatus(cardEl);
      return;
    }

    const computed = _computeFindMatches(text, needleRaw, opts, tokenHint);
    if (computed === null) return;
    _findMatches = computed;
    _findState.matches = computed;
    _findState.total = computed.length;

    if (!_findMatches.length) {
      _renderFindOverlay(cardEl, text, needleRaw, opts);
      _syncFindStatus(cardEl);
      return;
    }

    _findIndex = 0;
    _findState.activeIndex = 0;
    _renderFindOverlay(cardEl, text, needleRaw, opts);

    const m0 = _findMatches[0];
    if (!_findBarHasFocus(cardEl)) editor.setSelectionRange(m0.start, m0.end);
    _scrollEditorToMatch(cardEl, m0);
    _syncFindStatus(cardEl);
  }

  function _scheduleFindRebuild(cardEl) {
    if (_findDebounceTimer) clearTimeout(_findDebounceTimer);
    const token = ++_findBuildToken;
    _findState.buildToken = token;
    _findDebounceTimer = setTimeout(() => _rebuildFindMatches(cardEl, token), 140);
  }

  function _replaceCurrentFind(cardEl) {
    if (!_findOpen || !_findMatches.length) return false;
    const editor = cardEl?.querySelector("[data-editor]");
    const replaceInput = cardEl?.querySelector("[data-replace-input]");
    const hadFindFocus = _findBarHasFocus(cardEl);
    if (!editor || !replaceInput) return false;
    const m = _findMatches[Math.max(0, _findIndex)];
    if (!m) return false;
    const left = String(editor.value || "").slice(0, m.start);
    const right = String(editor.value || "").slice(m.end);
    const replacement = String(replaceInput.value || "");
    editor.value = left + replacement + right;
    current = String(editor.value || "");
    const caret = left.length + replacement.length;
    if (!hadFindFocus) editor.setSelectionRange(caret, caret);
    scheduleLineNumbersRefresh(editor, cardEl?.querySelector("[data-lines]"));
    _scheduleFindRebuild(cardEl);
    _updateEditorStatus(cardEl);
    if (hadFindFocus) {
      const findInput = cardEl?.querySelector("[data-find-input]");
      if (findInput) findInput.focus({ preventScroll: true });
    }
    return true;
  }

  function _replaceAllFind(cardEl) {
    if (!_findOpen) return 0;
    const editor = cardEl?.querySelector("[data-editor]");
    const findInput = cardEl?.querySelector("[data-find-input]");
    const replaceInput = cardEl?.querySelector("[data-replace-input]");
    if (!editor || !findInput || !replaceInput) return 0;
    const needleRaw = String(findInput.value || "");
    if (!needleRaw) return 0;
    const re = _buildFindRegex(needleRaw, _getFindOptions(cardEl));
    if (!re) return 0;
    let count = 0;
    const replacement = String(replaceInput.value || "");
    editor.value = String(editor.value || "").replace(re, () => {
      count += 1;
      return replacement;
    });
    current = String(editor.value || "");
    scheduleLineNumbersRefresh(editor, cardEl?.querySelector("[data-lines]"));
    _scheduleFindRebuild(cardEl);
    _updateEditorStatus(cardEl);
    return count;
  }

  function _updateEditorStatus(cardEl) {
    const editor = cardEl?.querySelector("[data-editor]");
    if (!editor) return;
    const text = String(editor.value || "");
    const pos = Number.isFinite(editor.selectionStart) ? editor.selectionStart : 0;
    const upto = text.slice(0, pos);
    const line = upto.split(/\n/).length;
    const col = pos - upto.lastIndexOf("\n");
    _lineEnding = /\r\n/.test(text) ? "CRLF" : "LF";
    const modeEl = cardEl?.querySelector("[data-status-mode]");
    const posEl = cardEl?.querySelector("[data-status-pos]");
    const sizeEl = cardEl?.querySelector("[data-status-size]");
    const eolEl = cardEl?.querySelector("[data-status-eol]");
    const encEl = cardEl?.querySelector("[data-status-enc]");
    if (modeEl) modeEl.textContent = editing ? "Edit" : "View";
    if (posEl) posEl.textContent = `Ln ${line}, Col ${Math.max(1, col)}`;
    if (sizeEl) sizeEl.textContent = fmtBytes(text.length);
    if (eolEl) eolEl.textContent = _lineEnding;
    if (encEl) encEl.textContent = _encoding;
  }

  function _selectFindMatchByIndex(cardEl, nextIndex) {
    const editor = cardEl?.querySelector("[data-editor]");
    const overlayContent = cardEl?.querySelector("[data-find-overlay-content]");
    const hadFindFocus = _findBarHasFocus(cardEl);
    if (!editor || !_findMatches.length) {
      _syncFindStatus(cardEl);
      return false;
    }

    const total = _findMatches.length;
    _findIndex = ((nextIndex % total) + total) % total;
    _findState.activeIndex = _findIndex;
    const m = _findMatches[_findIndex];
    if (!hadFindFocus) editor.setSelectionRange(m.start, m.end);

    if (overlayContent) {
      const marks = overlayContent.querySelectorAll("mark.findMatch");
      if (marks.length === _findMatches.length) {
        marks.forEach((el, i) => el.classList.toggle("findMatchActive", i == _findIndex));
      } else {
        const findInput = cardEl?.querySelector("[data-find-input]");
        _renderFindOverlay(cardEl, String(editor.value || ""), String(findInput?.value || ""), _getFindOptions(cardEl));
      }
    }

    _scrollEditorToMatch(cardEl, m);
    if (hadFindFocus) {
      const findInput = cardEl?.querySelector("[data-find-input]");
      if (findInput) findInput.focus({ preventScroll: true });
    }
    _syncFindStatus(cardEl);
    return true;
  }

  function _findInEditor(cardEl, direction) {
    if (!_findState.isOpen) return false;
    if (!_findMatches.length) {
      _scheduleFindRebuild(cardEl);
      return false;
    }
    const step = direction === "prev" ? -1 : 1;
    const start = _findIndex < 0 ? 0 : _findIndex;
    return _selectFindMatchByIndex(cardEl, start + step);
  }

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
      const viewLinesEl = body.querySelector("[data-view-lines]");
      if (codeEl) codeEl.innerHTML = highlight(current, lang);
      updateViewerLineNumbers(current, viewLinesEl);
    }

    const metaEl = card.querySelector("[data-meta]");
    if (metaEl) metaEl.textContent = `${String(ext || "").replace(".", "").toUpperCase() || "FILE"} · ${fmtBytes(sizeBytes)}`;
  }

  function setEditing(on) {
    closeFindBar(card, false);
    editing = Boolean(on);
    const editor = card.querySelector("[data-editor]");
    const editWrap = card.querySelector("[data-edit-wrap]");
    const viewer = card.querySelector("[data-viewer]");
    const btnEdit = card.querySelector("[data-edit]");
    const btnSave = card.querySelector("[data-save]");
    const btnCancel = card.querySelector("[data-cancel]");
    const btnRaw = card.querySelector("[data-raw]");
    const btnClose = card.querySelector("[data-close]");
    const confirmBar = card.querySelector("[data-confirm]");

    card.dataset.editing = editing ? "1" : "0";
    if (!card.dataset.findOpen) card.dataset.findOpen = "0";
    if (!editing && confirmBar) confirmBar.style.display = "none";

    if (btnClose) btnClose.style.display = editing ? "none" : "";

    if (editWrap) editWrap.style.display = editing ? "block" : "none";
    if (editor) {
      editor.style.display = editing ? "" : "none";
      if (editing) editor.value = current;
    }
    if (editing) {
      const gutterPre = card.querySelector("[data-lines]");
      const gutter = card.querySelector("[data-gutter]");
      updateLineNumbers(editor, gutterPre);
      syncEditorGutterScroll(editor, gutter);
      _updateEditorStatus(card);
    }
    if (viewer) viewer.style.display = editing ? "none" : "";
    if (btnEdit) btnEdit.classList.toggle("active", editing);
    if (btnSave) btnSave.style.display = editing ? "" : "none";
    if (btnCancel) btnCancel.style.display = editing ? "" : "none";
    if (btnRaw) btnRaw.style.display = !editing ? "" : "none";
    _updateEditorStatus(card);
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
            : `<div class="fvCodeWithLines" data-code-wrap="1">
                 <pre class="fvLineNums" data-view-lines="1"></pre>
                 <pre class="fvCode"><code data-code="1">${highlight(current, lang)}</code></pre>
               </div>`
        }
      </div>

      <div class="fvEditWrap" data-edit-wrap="1" style="display:none">
        <div class="fvFindBar" data-findbar="1" hidden>
          <input type="text" class="fvFindInput" data-find-input="1" placeholder="Find" aria-label="Find in editor" />
          <input type="text" class="fvFindInput fvReplaceInput" data-replace-input="1" placeholder="Replace" aria-label="Replace in editor" />
          <label class="fvFindOpt"><input type="checkbox" data-find-case="1" /> Aa</label>
          <label class="fvFindOpt"><input type="checkbox" data-find-word="1" /> W</label>
          <button class="fvFindBtn" type="button" data-find-prev="1">Prev</button>
          <button class="fvFindBtn" type="button" data-find-next="1">Next</button>
          <button class="fvFindBtn" type="button" data-replace-next="1">Replace</button>
          <button class="fvFindBtn" type="button" data-replace-all="1">Replace All</button>
          <button class="fvFindBtn" type="button" data-find-close="1" aria-label="Close find">×</button>
          <span class="fvFindStatus" data-find-status="1"></span>
        </div>
        <div class="fvEditMain">
          <div class="fvGutter" data-gutter="1" aria-hidden="true"><pre data-lines="1">1</pre></div>
          <div class="fvEditorStack" data-editor-stack="1">
            <pre class="fvFindOverlay" data-find-overlay="1" hidden><code data-find-overlay-content="1"></code></pre>
            <textarea class="fvEditor" data-editor="1" spellcheck="false" style="display:none"></textarea>
          </div>
        </div>
        <div class="fvStatusBar" data-statusbar="1">
          <span data-status-mode="1">View</span>
          <span data-status-pos="1">Ln 1, Col 1</span>
          <span data-status-size="1">${escapeHtml(fmtBytes(sizeBytes))}</span>
          <span data-status-eol="1">${escapeHtml(_lineEnding)}</span>
          <span data-status-enc="1">${escapeHtml(_encoding)}</span>
        </div>
      </div>
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

    const editorEl = card.querySelector("[data-editor]");
    const gutterPre = card.querySelector("[data-lines]");
    scheduleLineNumbersRefresh(editorEl, gutterPre);
    _updateEditorStatus(card);
    if (_findOpen) _scheduleFindRebuild(card);
  });

  card.querySelector("[data-editor]")?.addEventListener("scroll", (e) => {
    const gutter = card.querySelector("[data-gutter]");
    syncEditorGutterScroll(e.target, gutter);
    _scrollFindOverlayWithEditor(card);
  });

  card.querySelector("[data-editor]")?.addEventListener("keydown", (e) => {
    const findBar = card.querySelector("[data-findbar]");
    if (findBar && findBar.contains(document.activeElement)) return;
    if ((e.ctrlKey || e.metaKey) && String(e.key || "").toLowerCase() === "f") {
      e.preventDefault();
      if (!editing) return;
      openFindBar(card);
      _scheduleFindRebuild(card);
      return;
    }
    if (String(e.key || "") === "Escape") {
      if (_findOpen && findBar && !findBar.hidden) {
        e.preventDefault();
        closeFindBar(card, true);
      }
    }
  });

  card.querySelector("[data-editor]")?.addEventListener("click", () => _updateEditorStatus(card));
  card.querySelector("[data-editor]")?.addEventListener("keyup", () => _updateEditorStatus(card));

  card.querySelector("[data-find-close]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    closeFindBar(card, true);
  });

  card.querySelector("[data-find-next]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _findInEditor(card, "next");
  });

  card.querySelector("[data-find-prev]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _findInEditor(card, "prev");
  });

  card.querySelector("[data-find-input]")?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (String(e.key || "") === "Escape") {
      e.preventDefault();
      closeFindBar(card, true);
      return;
    }
    if (String(e.key || "") === "Enter") {
      e.preventDefault();
      _findInEditor(card, e.shiftKey ? "prev" : "next");
    }
  });

  card.querySelector("[data-find-input]")?.addEventListener("input", (e) => {
    e.stopPropagation();
    if (!_findOpen) return;
    if (_findTypingTimer) clearTimeout(_findTypingTimer);
    _findTypingTimer = setTimeout(() => {
      _findTypingTimer = null;
      _scheduleFindRebuild(card);
    }, 120);
  });

  card.querySelector("[data-find-input]")?.addEventListener("blur", () => {
    if (_findTypingTimer) {
      clearTimeout(_findTypingTimer);
      _findTypingTimer = null;
      if (_findOpen) _scheduleFindRebuild(card);
    }
  });

  card.querySelector("[data-find-input]")?.addEventListener("compositionend", () => {
    if (!_findOpen) return;
    _scheduleFindRebuild(card);
  });

  card.querySelector("[data-replace-input]")?.addEventListener("keydown", (e) => {
    e.stopPropagation();
  });

  card.querySelector("[data-replace-input]")?.addEventListener("input", (e) => {
    e.stopPropagation();
  });

  card.querySelector("[data-replace-next]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    _replaceCurrentFind(card);
  });

  card.querySelector("[data-replace-all]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const total = _replaceAllFind(card);
    if (total > 0) addLog(`[FILE_EDIT] Replaced ${total} match(es) in ${relPath || absPath}`);
  });

  card.querySelector("[data-find-case]")?.addEventListener("change", () => {
    if (!_findOpen) return;
    _scheduleFindRebuild(card);
  });

  card.querySelector("[data-find-word]")?.addEventListener("change", () => {
    if (!_findOpen) return;
    _scheduleFindRebuild(card);
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
      if(n.isDir && expandedPaths.has(_normalizeAbsPath(n.absPath))) expanded.add(n.id);
      if(n.children && n.children.length) n.children.forEach(walk);
    };
    walk(tree);
    for(const p of Array.from(expandedPaths)){
      if(!dirSet.has(_normalizeAbsPath(p))) expandedPaths.delete(p);
    }
  }catch{}
}

function _cleanupExpandedPathsFromTree(tree){
  try{
    const dirSet = new Set();
    const walk = (n)=>{
      if(!n) return;
      if(n.isDir) dirSet.add(_normalizeAbsPath(n.absPath));
      if(n.children && n.children.length) n.children.forEach(walk);
    };
    walk(tree);
    for(const p of Array.from(expandedPaths)){
      if(!dirSet.has(_normalizeAbsPath(p))) expandedPaths.delete(p);
    }
  }catch{}
}

function _cleanupExpandedPathsFromTree(tree){
  try{
    const dirSet = new Set();
    const walk = (n)=>{
      if(!n) return;
      if(n.isDir) dirSet.add(_normalizeAbsPath(n.absPath));
      if(n.children && n.children.length) n.children.forEach(walk);
    };
    walk(tree);
    for(const p of Array.from(expandedPaths)){
      if(!dirSet.has(_normalizeAbsPath(p))) expandedPaths.delete(p);
    }
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

function _fileSearchMode(query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return null;
  return {
    query: q,
    byPath: q.includes("/"),
  };
}

function _nodeMatchesSearch(node, searchMode) {
  if (!searchMode) return true;
  const name = String(node.name || "").toLowerCase();
  if (!searchMode.byPath) return name.includes(searchMode.query);

  const relPath = String(node.relPath || node.absPath || node.name || "").replaceAll("\\", "/").toLowerCase();
  return relPath.includes(searchMode.query);
}

function flattenTreeFiltered(node, depth, out, ignoredSet, searchMode) {
  const hasChildren = node.isDir && node.children && node.children.length > 0;
  const selfMatches = _nodeMatchesSearch(node, searchMode);
  let childMatched = false;
  const childRows = [];

  if (hasChildren) {
    for (const ch of node.children) {
      if (flattenTreeFiltered(ch, depth + 1, childRows, ignoredSet, searchMode)) childMatched = true;
    }
  }

  if (selfMatches || childMatched) {
    out.push({
      id: node.id,
      name: node.name,
      absPath: node.absPath,
      isDir: node.isDir,
      hasChildren,
      depth,
      ignored: ignoredSet.has(node.absPath),
    });
    if (childRows.length) out.push(...childRows);
    return true;
  }

  return false;
}

function _updateFilesSearchUi() {
  const wrap = el("filesSearchWrap");
  const clearBtn = el("filesSearchClear");
  const hasValue = String(filesSearchQuery || "").trim().length > 0;
  if (wrap) wrap.classList.toggle("hasValue", hasValue);
  if (clearBtn) clearBtn.style.display = hasValue ? "inline-flex" : "none";
}

function _setFilesSearchQuery(nextQuery) {
  filesSearchQuery = String(nextQuery || "");
  const input = el("filesSearchInput");
  if (input && input.value !== filesSearchQuery) input.value = filesSearchQuery;
  _updateFilesSearchUi();
  if (lastSnapshot) render(lastSnapshot);
}

function _updateItemsCount(snapshot, visibleCount) {
  const total = Number(snapshot?.stats?.items || 0);
  const hasFilter = String(filesSearchQuery || "").trim().length > 0;
  if (hasFilter && Number.isFinite(visibleCount)) {
    el("itemsCount").textContent = `${visibleCount} / ${total} items`;
    return;
  }
  el("itemsCount").textContent = `${total} items`;
}

function _virtualRange(total, rowH, viewportH, scrollTop, overscan) {
  if (!total) return { start: 0, end: 0 };
  const first = Math.floor(scrollTop / rowH);
  const visible = Math.max(1, Math.ceil(viewportH / rowH));
  const start = Math.max(0, first - overscan);
  const end = Math.min(total, first + visible + overscan);
  return { start, end };
}

function _normalizeAbsPath(p) {
  return String(p || "").replaceAll("\\", "/");
}

function _isSelectedPath(absPath) {
  const p = _normalizeAbsPath(absPath);
  return _exportSelectionState.selected.has(p);
}

function _toggleSelectedPath(absPath) {
  const p = _normalizeAbsPath(absPath);
  if (!p) return;
  if (_exportSelectionState.selected.has(p)) _exportSelectionState.selected.delete(p);
  else _exportSelectionState.selected.add(p);
}

function _collectDescendantsFromSnapshot(snapshot, folderPathNormalized) {
  const out = [];
  if (!snapshot?.tree || !folderPathNormalized) return out;

  let target = null;
  const walkFind = (node) => {
    if (!node || target) return;
    if (_normalizeAbsPath(node.absPath) === folderPathNormalized) {
      target = node;
      return;
    }
    for (const ch of node.children || []) walkFind(ch);
  };
  walkFind(snapshot.tree);
  if (!target) return out;

  const walkDesc = (node) => {
    if (!node) return;
    for (const ch of node.children || []) {
      out.push(_normalizeAbsPath(ch.absPath));
      walkDesc(ch);
    }
  };
  walkDesc(target);
  return out;
}

function _collectSnapshotPathIndex(snapshot) {
  const all = new Set();
  const dirs = new Set();
  const walk = (node) => {
    if (!node) return;
    const normalized = _normalizeAbsPath(node.absPath);
    all.add(normalized);
    if (node.isDir || (Array.isArray(node.children) && node.children.length >= 0)) dirs.add(normalized);
    for (const ch of node.children || []) walk(ch);
  };
  walk(snapshot?.tree || null);
  return { all, dirs };
}

function _applyFolderSelection(selectedSet, folderPathNormalized, isSelecting, descendantsList) {
  if (!selectedSet || !folderPathNormalized) return;
  const all = [folderPathNormalized, ...(descendantsList || [])];
  if (isSelecting) {
    for (const p of all) selectedSet.add(_normalizeAbsPath(p));
  } else {
    for (const p of all) selectedSet.delete(_normalizeAbsPath(p));
  }
}

function _cleanupSelectionWithSnapshot(snapshot) {
  try {
    if (!snapshot?.projectPath) {
      _exportSelectionState.selected.clear();
      return;
    }
    const indexSet = new Set();
    const walk = (node) => {
      if (!node) return;
      indexSet.add(_normalizeAbsPath(node.absPath));
      if (Array.isArray(node.children)) node.children.forEach(walk);
    };
    walk(snapshot.tree);
    const next = new Set();
    for (const p of _exportSelectionState.selected) {
      const pn = _normalizeAbsPath(p);
      if (indexSet.has(pn)) next.add(pn);
    }
    _exportSelectionState.selected = next;
  } catch {}
}

function _collectExportableFromSelection(snapshot) {
  const ignoredSet = new Set(snapshot?.ignored || []);
  const fileRows = [];
  const walk = (n) => {
    if (!n) return;
    if (!n.isDir) {
      fileRows.push({ absPath: String(n.absPath || "") });
      return;
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(snapshot?.tree);
  const out = new Set();
  const selected = _exportSelectionState.selected;
  const normSel = Array.from(selected).map((p) => _normalizeAbsPath(p));

  for (const r of fileRows) {
    if (ignoredSet.has(r.absPath)) continue;
    const ext = path.extname(String(r.absPath || "")) || "";
    if (DEFAULT_IGNORE_EXTS && DEFAULT_IGNORE_EXTS.has && DEFAULT_IGNORE_EXTS.has(ext)) continue;
    const rp = _normalizeAbsPath(r.absPath);
    let picked = selected.has(rp);
    if (!picked) {
      for (const s of normSel) {
        if (!s) continue;
        if (rp === s || rp.startsWith(s.endsWith("/") ? s : s + "/")) {
          picked = true;
          break;
        }
      }
    }
    if (picked) out.add(rp);
  }
  return out;
}

function _countExportableAll(snapshot) {
  const ignoredSet = new Set(snapshot?.ignored || []);
  let count = 0;
  const walk = (n) => {
    if (!n) return;
    if (!n.isDir) {
      const abs = String(n.absPath || "");
      if (!ignoredSet.has(abs)) {
        const ext = path.extname(abs) || "";
        if (!(DEFAULT_IGNORE_EXTS && DEFAULT_IGNORE_EXTS.has && DEFAULT_IGNORE_EXTS.has(ext))) count += 1;
      }
      return;
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(snapshot?.tree);
  return count;
}

function _collectExportableAll(snapshot) {
  const ignoredSet = new Set(snapshot?.ignored || []);
  const out = new Set();
  const walk = (n) => {
    if (!n) return;
    if (!n.isDir) {
      const abs = String(n.absPath || "");
      if (!ignoredSet.has(abs)) {
        const ext = path.extname(abs) || "";
        if (!(DEFAULT_IGNORE_EXTS && DEFAULT_IGNORE_EXTS.has && DEFAULT_IGNORE_EXTS.has(ext))) {
          out.add(_normalizeAbsPath(abs));
        }
      }
      return;
    }
    for (const ch of n.children || []) walk(ch);
  };
  walk(snapshot?.tree);
  return out;
}

function _safeRelForExport(root, abs) {
  try {
    return String(path.relative(String(root || ""), String(abs || "")) || path.basename(String(abs || ""))).replaceAll("\\", "/");
  } catch {
    return String(abs || "").replaceAll("\\", "/");
  }
}

function _hashStable(input) {
  try {
    return crypto.createHash("sha1").update(String(input || ""), "utf8").digest("hex");
  } catch {
    return String(input || "");
  }
}

function _buildExportSizeKey(snapshot, profile, resolvedAbs) {
  const root = String(snapshot?.projectPath || "");
  const rels = (resolvedAbs || []).map((p) => _safeRelForExport(root, p)).sort((a, b) => a.localeCompare(b));
  const stats = snapshot?.stats || {};
  const sigObj = {
    root,
    format: profile?.format || "txt",
    scope: profile?.scope || "all",
    content_level: profile?.content_level || "full",
    include_tree: Boolean(profile?.include_tree),
    include_hashes: Boolean(profile?.include_hashes),
    include_ignored_summary: Boolean(profile?.include_ignored_summary),
    sort_mode: profile?.sort_mode || "dir_first_alpha",
    selected_count: _exportSelectionState.selected.size,
    stats: {
      files: Number(stats.files || 0),
      folders: Number(stats.folders || 0),
      ignoredFiles: Number(stats.ignoredFiles || 0),
      ignoredFolders: Number(stats.ignoredFolders || 0),
    },
    rels,
  };
  return _hashStable(JSON.stringify(sigObj));
}

function _treeAddExportFile(root, relPath, fileIndex) {
  const parts = String(relPath || "").split("/").filter(Boolean);
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i];
    const isLast = i === parts.length - 1;
    const pathRel = parts.slice(0, i + 1).join("/");
    if (isLast) {
      cur.children.push({ type: "file", name, path: pathRel, file_index: fileIndex });
      return;
    }
    let next = cur.children.find((c) => c.type === "dir" && c.name === name);
    if (!next) {
      next = { type: "dir", name, path: pathRel, children: [] };
      cur.children.push(next);
    }
    cur = next;
  }
}

function _sortExportTree(node, sortMode = "dir_first_alpha") {
  if (!node || !Array.isArray(node.children)) return;
  for (const ch of node.children) _sortExportTree(ch, sortMode);
  node.children.sort((a, b) => {
    if (sortMode === "dir_first_alpha") {
      const ta = a.type === "dir" ? 0 : 1;
      const tb = b.type === "dir" ? 0 : 1;
      if (ta !== tb) return ta - tb;
    }
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

async function _readFileForExport(absPath, includeContent, includeHashes) {
  let st = null;
  try { st = await fs.promises.stat(absPath); } catch {}
  const sizeBytes = Number(st?.size || 0);
  const mtimeMs = Number.isFinite(Number(st?.mtimeMs)) ? Number(st.mtimeMs) : null;
  if (!includeContent && !includeHashes) {
    return {
      size_bytes: sizeBytes,
      mtime_ms: mtimeMs,
      encoding: null,
      line_count: null,
      sha256: null,
      content: null,
      content_error: null,
    };
  }

  try {
    const buf = await fs.promises.readFile(absPath);
    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
      if (buf[i] === 0) {
        return {
          size_bytes: sizeBytes,
          mtime_ms: mtimeMs,
          encoding: includeContent ? null : null,
          line_count: includeContent ? null : null,
          sha256: includeHashes ? null : null,
          content: includeContent ? null : null,
          content_error: includeContent ? "binary_or_decode_failed" : null,
        };
      }
    }
    const dec = new TextDecoder("utf-8", { fatal: true });
    const content = dec.decode(buf);
    const lineCount = content.length ? content.split(/\r?\n/).length : 0;
    const hash = includeHashes ? crypto.createHash("sha256").update(String(content), "utf8").digest("hex") : null;
    return {
      size_bytes: sizeBytes,
      mtime_ms: mtimeMs,
      encoding: includeContent ? "utf-8" : null,
      line_count: includeContent ? lineCount : null,
      sha256: hash,
      content: includeContent ? content : null,
      content_error: includeContent ? null : null,
    };
  } catch {
    return {
      size_bytes: sizeBytes,
      mtime_ms: mtimeMs,
      encoding: includeContent ? null : null,
      line_count: includeContent ? null : null,
      sha256: includeHashes ? null : null,
      content: includeContent ? null : null,
      content_error: includeContent ? "binary_or_decode_failed" : null,
    };
  }
}

async function _buildUnifiedReportForSize(snapshot, profile, resolvedAbs) {
  const root = String(snapshot?.projectPath || "");
  const ignored = Array.from(new Set(snapshot?.ignored || []))
    .map((p) => _safeRelForExport(root, p))
    .sort((a, b) => a.localeCompare(b));
  const includeContent = profile.content_level !== "compact";
  const includeHashes = Boolean(profile.include_hashes);
  const absList = Array.from(new Set(resolvedAbs || [])).sort((a, b) => a.localeCompare(b));
  const files = [];

  for (let i = 0; i < absList.length; i++) {
    const absPath = absList[i];
    const meta = await _readFileForExport(absPath, includeContent, includeHashes);
    const relPath = _safeRelForExport(root, absPath);
    files.push({
      path: relPath,
      ext: path.extname(relPath) || "",
      size_bytes: meta.size_bytes,
      mtime_ms: meta.mtime_ms,
      encoding: meta.encoding,
      line_count: meta.line_count,
      sha256: meta.sha256,
      content: meta.content,
      content_error: meta.content_error,
    });
    if (i % 40 === 0) await new Promise((r) => setTimeout(r, 0));
  }

  files.sort((a, b) => String(a.path || "").localeCompare(String(b.path || "")));

  const tree = { type: "dir", name: ".", path: "", children: [] };
  const byPath = {};
  for (let i = 0; i < files.length; i++) {
    const rel = String(files[i].path || "").replaceAll("\\", "/");
    _treeAddExportFile(tree, rel, i);
    byPath[rel] = i;
  }
  _sortExportTree(tree, profile.sort_mode);

  return {
    schema_version: 1,
    report_type: "project_report",
    project: {
      path: root,
      generated_at: new Date().toISOString(),
      generator: "Project Manager & SV Patch",
      app_version: null,
    },
    export: {
      mode: profile.scope === "selected" ? "selected" : "all",
      profile,
      selected_count: profile.scope === "selected" ? _exportSelectionState.selected.size : 0,
      exported_files_count: files.length,
      filters: {
        ignored_exts: Array.from(DEFAULT_IGNORE_EXTS).sort((a, b) => String(a).localeCompare(String(b))),
        ignored_paths: ignored,
      },
    },
    tree,
    files,
    index: { by_path: byPath },
    project_path: root,
    generated_at: new Date().toISOString().replace("T", " ").slice(0, 19),
    ignored,
  };
}

function _renderTxtFromReport(report, projectPath) {
  const lines = [];
  lines.push("PROJECT REPORT");
  lines.push("=".repeat(72));
  lines.push(`Project: ${report.project?.path || projectPath || ""}`);
  lines.push(`Generated: ${report.project?.generated_at || report.generated_at || ""}`);
  lines.push(`Mode: ${report.export?.mode || "all"}`);
  lines.push(`Exported files: ${Number(report.export?.exported_files_count || report.files?.length || 0)}`);
  lines.push("");

  if (report.export?.profile?.include_tree !== false) {
    lines.push("EXPORTED TREE");
    lines.push("-".repeat(72));
    const walkTree = (node, depth) => {
      if (!node) return;
      if (depth > 0) {
        const pad = "  ".repeat(Math.max(0, depth - 1));
        lines.push(`${pad}${node.name}${node.type === "dir" ? "/" : ""}`);
      }
      if (Array.isArray(node.children)) {
        for (const ch of node.children) walkTree(ch, depth + 1);
      }
    };
    walkTree(report.tree, 0);
    lines.push("");
  }

  if (report.export?.profile?.include_ignored_summary !== false && Array.isArray(report.ignored) && report.ignored.length) {
    lines.push("Ignored:");
    for (const ig of report.ignored) lines.push(`- ${ig}`);
    lines.push("");
  }

  const files = Array.isArray(report.files) ? report.files : [];
  for (const file of files) {
    lines.push("-".repeat(72));
    lines.push(`File: ${file.path}`);
    lines.push(`Ext: ${file.ext} · Bytes: ${file.size_bytes ?? 0} · Lines: ${file.line_count ?? "-"} · Encoding: ${file.encoding || "-"}`);
    lines.push("");
    if (typeof file.content === "string") lines.push(file.content);
    else lines.push(`[Could not read: ${file.content_error || "binary_or_decode_failed"}]`);
    lines.push("");
  }

  return lines.join("\n");
}

function _formatArchiveSizeText(status, bytes, hasError) {
  if (status === "loading") return "Loading…";
  if (typeof bytes === "number" && Number.isFinite(bytes)) {
    const kb = bytes / 1024;
    const bytesFmt = new Intl.NumberFormat().format(bytes);
    return `${bytesFmt} bytes (${kb.toFixed(1)} KB)${hasError ? " (error)" : ""}`;
  }
  return hasError ? "Loading… (error)" : "Loading…";
}

function _scheduleExportSizeRecalc(snapshot, profile, resolvedAbs) {
  if (!snapshot?.projectPath) return;
  const key = _buildExportSizeKey(snapshot, profile, resolvedAbs);
  _exportSizeState.key = key;

  if (_exportSizeState.cache.has(key)) {
    const bytes = _exportSizeState.cache.get(key);
    _exportSizeState.status = "ready";
    _exportSizeState.bytes = bytes;
    _exportSizeState.lastStableBytes = bytes;
    return;
  }

  if (_exportSizeState.debounceTimer) {
    clearTimeout(_exportSizeState.debounceTimer);
    _exportSizeState.debounceTimer = null;
  }

  const token = ++_exportSizeState.token;
  _exportSizeState.status = "loading";

  _exportSizeState.debounceTimer = setTimeout(async () => {
    try {
      const report = await _buildUnifiedReportForSize(snapshot, profile, resolvedAbs);
      if (token !== _exportSizeState.token) return;
      const rendered = profile.format === "json"
        ? JSON.stringify(report, null, 2)
        : _renderTxtFromReport(report, snapshot.projectPath);
      const bytes = Buffer.byteLength(rendered, "utf8");
      if (token !== _exportSizeState.token) return;
      _exportSizeState.cache.set(key, bytes);
      _exportSizeState.status = "ready";
      _exportSizeState.bytes = bytes;
      _exportSizeState.lastStableBytes = bytes;
      _updateExportLiveSummary(snapshot);
    } catch {
      if (token !== _exportSizeState.token) return;
      _exportSizeState.status = "error";
      _exportSizeState.bytes = _exportSizeState.lastStableBytes;
      _updateExportLiveSummary(snapshot);
    }
  }, 180);
}

function _buildExportProfile() {
  return {
    profile_id: "default",
    format: _exportUi.type === "json" ? "json" : "txt",
    scope: _exportSelectionState.selectedMode === "selected" ? "selected" : "all",
    content_level: _exportUi.contentLevel === "compact" ? "compact" : "full",
    include_tree: Boolean(_exportUi.options.treeHeader),
    include_hashes: Boolean(_exportUi.options.hashes),
    include_ignored_summary: Boolean(_exportUi.options.ignoredSummary),
    sort_mode: _exportUi.options.sortDet === false ? "alpha" : "dir_first_alpha",
    schema_version: 1,
  };
}

function _updateExportSelectionMeta(snapshot) {
  const countEl = el("exportSelectedCount");
  const selectedCount = _exportSelectionState.selected.size;
  const resolved = _collectExportableFromSelection(snapshot || lastSnapshot || {}).size;
  if (countEl) countEl.textContent = `Selected: ${selectedCount} · Resolved files: ${resolved}`;
  const countElTab = el("exportSelectedCountTab");
  if (countElTab) countElTab.textContent = `Selected: ${selectedCount} · Resolved files: ${resolved}`;
  _updateExportLiveSummary(snapshot);
}

function _writeExportSelectionConfig(snapshot) {
  try {
    const root = String(snapshot?.projectPath || "");
    if (!root) return;
    const cfgPath = path.join(root, _exportSelectionFile);
    const payload = {
      selectedOnly: _exportSelectionState.selectedMode === "selected",
      selectedMode: _exportSelectionState.selectedMode,
      profile: _buildExportProfile(),
      selected: Array.from(_exportSelectionState.selected).map((p) => _normalizeAbsPath(p)),
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {}
}

function _loadExportUiConfig() {
  try {
    const raw = localStorage.getItem("pm_sv_export_ui_v1");
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj?.type === "txt" || obj?.type === "json") _exportUi.type = obj.type;
    if (["compact", "standard", "full"].includes(obj?.contentLevel)) _exportUi.contentLevel = obj.contentLevel;
    if (obj && typeof obj.options === "object") {
      _exportUi.options.treeHeader = Boolean(obj.options.treeHeader ?? _exportUi.options.treeHeader);
      _exportUi.options.ignoredSummary = Boolean(obj.options.ignoredSummary ?? _exportUi.options.ignoredSummary);
      _exportUi.options.hashes = Boolean(obj.options.hashes ?? _exportUi.options.hashes);
      _exportUi.options.sortDet = Boolean(obj.options.sortDet ?? _exportUi.options.sortDet);
    }
  } catch {}
}

function _saveExportUiConfig() {
  try {
    localStorage.setItem("pm_sv_export_ui_v1", JSON.stringify(_exportUi));
  } catch {}
}

function _setPresetFeedback(message, mode = "none") {
  const fb = el("presetFeedback");
  if (!fb) return;
  fb.textContent = message || "Preset: idle";
  fb.classList.remove("ok", "partial", "broken", "loading", "error", "cancel");
  if (mode && mode !== "none") fb.classList.add(mode);
}
function _defaultPresetName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `preset-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.pmspreset.json`;
}

function _setPresetFeedbackTimed(message, mode = "none", ttl = 4800) {
  _setPresetFeedback(message, mode);
  try { if (_exportPresetState.feedbackTimer) clearTimeout(_exportPresetState.feedbackTimer); } catch {}
  if (mode === "loading") return;
  _exportPresetState.feedbackTimer = setTimeout(() => {
    if (_exportPresetState.lastPresetPath) {
      _setPresetFeedback(`Preset file: ${path.basename(_exportPresetState.lastPresetPath)}`, "none");
    } else {
      _setPresetFeedback("Preset: idle", "none");
    }
  }, Math.max(1200, Number(ttl || 0)));
}

function _setPresetActionButtonsBusy(busy) {
  const bSave = el("btnPresetSaveFile");
  const bImport = el("btnPresetImportFile");
  if (bSave) bSave.disabled = !!busy;
  if (bImport) bImport.disabled = !!busy;
}

// Backward compatibility shim for legacy preset UI calls.
function _refreshPresetControlsUi() {
  _setPresetActionButtonsBusy(Boolean(_exportPresetState.applying));
  if (_exportPresetState.lastPresetPath) {
    _setPresetFeedback(`Preset file: ${path.basename(_exportPresetState.lastPresetPath)}`, "none");
  } else {
    _setPresetFeedback("Preset: idle", "none");
  }
}

function _markPresetRefreshCycle() {
  try {
    _exportPresetState.applyToken = Number(_exportPresetState.applyToken || 0) + 1;
  } catch {}
}

function _maybeAutoApplyPreset(_snapshot) {
  // File-based preset workflow is explicit/manual-only.
  // Keep as compatibility no-op so legacy call sites cannot throw.
  return false;
}

function _buildPresetV1(snapshot) {
  return {
    schema_version: "preset.v1",
    created_at: new Date().toISOString(),
    project_root: String(snapshot?.projectPath || ""),
    export: {
      profile: _buildExportProfile(),
      scope: {
        mode: _exportSelectionState.selectedMode === "selected" ? "selected" : "all",
        selected: Array.from(_exportSelectionState.selected || []).map((p) => _normalizeAbsPath(p)),
      },
    },
    tree: {
      expanded_paths: Array.from(expandedPaths || []).map((p) => _normalizeAbsPath(p)),
    },
  };
}

function _validatePresetV1(presetObj, snapshot) {
  if (!presetObj || typeof presetObj !== "object") return { ok: false, error: "Preset JSON must be an object" };
  if (presetObj.schema_version !== "preset.v1") return { ok: false, error: "Invalid schema_version (expected preset.v1)" };
  if (!snapshot?.projectPath) return { ok: false, error: "No active project" };
  if (String(presetObj.project_root || "") !== String(snapshot.projectPath || "")) {
    return { ok: false, error: "Preset belongs to another project", mismatch: true };
  }
  if (!presetObj.export || typeof presetObj.export !== "object") return { ok: false, error: "Missing export section" };
  return { ok: true };
}

function _classifyPresetApplyHealth(snapshot, requestedSelection) {
  const idx = _collectSnapshotPathIndex(snapshot || {});
  const req = Array.isArray(requestedSelection) ? requestedSelection.map((p) => _normalizeAbsPath(p)).filter(Boolean) : [];
  let resolved = 0;
  let missing = 0;
  for (const p of req) {
    if (idx.all.has(p)) resolved += 1;
    else missing += 1;
  }
  if (resolved === 0 && req.length > 0) return { status: "BROKEN", missing };
  if (missing > 0) return { status: "PARTIAL", missing };
  return { status: "OK", missing: 0 };
}

function _applyExportProfileToUi(profile) {
  if (!profile || typeof profile !== "object") return;
  _exportUi.type = profile.format === "json" ? "json" : "txt";
  _exportUi.contentLevel = profile.content_level === "compact" ? "compact" : "full";
  _exportUi.options.treeHeader = Boolean(profile.include_tree);
  _exportUi.options.ignoredSummary = Boolean(profile.include_ignored_summary);
  _exportUi.options.hashes = Boolean(profile.include_hashes);
  _exportUi.options.sortDet = profile.sort_mode !== "alpha";
  _syncExportUiControls();
  _saveExportUiConfig();
}

async function _applyPresetV1(snapshot, presetObj) {
  const token = ++_exportPresetState.applyToken;
  _exportPresetState.applying = true;
  _setPresetActionButtonsBusy(true);
  _setPresetFeedbackTimed("Applying preset… Loading…", "loading");

  try {
    const valid = _validatePresetV1(presetObj, snapshot);
    if (!valid.ok) {
      _setPresetFeedbackTimed(`Error: ${valid.error}`, valid.mismatch ? "broken" : "error", 5200);
      try { addLog(`[PRESET] import rejected: ${valid.error}`); } catch {}
      return;
    }

    const idxRaw = _collectSnapshotPathIndex(snapshot || {});
    const idx = {
      all: idxRaw?.all instanceof Set ? idxRaw.all : new Set(),
      dirs: idxRaw?.dirs instanceof Set ? idxRaw.dirs : new Set(),
    };
    if (__PM_UI_DEV__ && !(idxRaw?.dirs instanceof Set)) {
      console.error("[PRESET] idx.dirs missing before apply", typeof idxRaw?.dirs, idxRaw?.dirs);
    }

    const expandedSrc = Array.isArray(presetObj?.tree?.expanded_paths) ? presetObj.tree.expanded_paths : [];
    expandedPaths.clear();
    for (const ep of expandedSrc) {
      const p = _normalizeAbsPath(ep);
      if (p && idx.dirs.has(p)) expandedPaths.add(p);
    }

    const requestedSelection = Array.isArray(presetObj?.export?.scope?.selected) ? presetObj.export.scope.selected : [];
    _exportSelectionState.selectedMode = presetObj?.export?.scope?.mode === "selected" ? "selected" : "all";
    if (!(_exportSelectionState.selected instanceof Set)) _exportSelectionState.selected = new Set();
    _exportSelectionState.selected.clear();
    for (const p0 of requestedSelection) {
      const p = _normalizeAbsPath(p0);
      if (!p || !idx.all.has(p)) continue;
      _exportSelectionState.selected.add(p);
      if (idx.dirs.has(p)) {
        const descendants = _collectDescendantsFromSnapshot(snapshot, p);
        for (const d of descendants) {
          const dn = _normalizeAbsPath(d);
          if (idx.all.has(dn)) _exportSelectionState.selected.add(dn);
        }
      }
    }

    _applyExportProfileToUi(presetObj?.export?.profile || {});

    if (token !== _exportPresetState.applyToken) return;

    const mainChk = el("chkExportSelectedOnly");
    const tabChk = el("chkExportSelectedOnlyTab");
    const isSel = _exportSelectionState.selectedMode === "selected";
    if (mainChk) mainChk.checked = isSel;
    if (tabChk) tabChk.checked = isSel;

    render(snapshot);
    _updateExportSelectionMeta(snapshot);
    if (snapshot?.projectPath) _writeExportSelectionConfig(snapshot);

    const h = _classifyPresetApplyHealth(snapshot, requestedSelection);
    _exportPresetState.lastHealth = String(h.status || "OK").toLowerCase();
    const mode = h.status === "OK" ? "ok" : (h.status === "PARTIAL" ? "partial" : "broken");
    _setPresetFeedbackTimed(`Applied preset: ${h.status} (missing: ${h.missing})`, mode, 5200);
    try { addLog(`[PRESET] applied: ${h.status} missing=${h.missing}`); } catch {}
  } catch (e) {
    _setPresetFeedbackTimed(`Error: ${e?.message || e}`, "error", 5200);
    try { addLog(`[PRESET] apply error: ${e?.message || e}`); } catch {}
  } finally {
    if (token === _exportPresetState.applyToken) {
      _exportPresetState.applying = false;
      _setPresetActionButtonsBusy(false);
    }
  }
}

async function _savePresetToFile(snapshot) {
  if (!snapshot?.projectPath) {
    _setPresetFeedbackTimed("Error: open a project first", "error", 4200);
    return;
  }
  _setPresetActionButtonsBusy(true);
  _setPresetFeedbackTimed("Saving preset…", "loading");
  try {
    const preset = _buildPresetV1(snapshot);
    const payload = {
      suggestedName: _defaultPresetName(),
      projectRoot: String(snapshot.projectPath || ""),
      presetJsonString: JSON.stringify(preset, null, 2),
    };
    const res = await ipcRenderer.invoke("preset:saveAs", payload);
    if (res?.canceled) {
      _setPresetFeedbackTimed("Canceled", "cancel", 2800);
      try { addLog("[PRESET] save canceled"); } catch {}
      return;
    }
    if (!res?.ok) {
      _setPresetFeedbackTimed(`Error: ${res?.error || "save failed"}`, "error", 5200);
      try { addLog(`[PRESET] save error: ${res?.error || "save failed"}`); } catch {}
      return;
    }
    _exportPresetState.lastPresetPath = String(res.path || "");
    _setPresetFeedbackTimed(`Saved: ${path.basename(String(res.path || "preset"))}`, "ok", 4200);
    try { addLog(`[PRESET] saved: ${res.path}`); } catch {}
  } catch (e) {
    _setPresetFeedbackTimed(`Error: ${e?.message || e}`, "error", 5200);
  } finally {
    _setPresetActionButtonsBusy(false);
  }
}

async function _importPresetFromFile(snapshot) {
  if (!snapshot?.projectPath) {
    _setPresetFeedbackTimed("Error: open a project first", "error", 4200);
    return;
  }
  _setPresetActionButtonsBusy(true);
  _setPresetFeedbackTimed("Importing preset…", "loading");
  try {
    const res = await ipcRenderer.invoke("preset:open", { projectRoot: String(snapshot.projectPath || "") });
    if (res?.canceled) {
      _setPresetFeedbackTimed("Canceled", "cancel", 2800);
      try { addLog("[PRESET] import canceled"); } catch {}
      return;
    }
    if (!res?.ok) {
      _setPresetFeedbackTimed(`Error: ${res?.error || "import failed"}`, "error", 5200);
      try { addLog(`[PRESET] import error: ${res?.error || "import failed"}`); } catch {}
      return;
    }

    let parsed = null;
    try { parsed = JSON.parse(String(res.contents || "")); }
    catch (e) {
      _setPresetFeedbackTimed(`Error: invalid JSON (${e?.message || e})`, "error", 5200);
      try { addLog(`[PRESET] invalid JSON: ${e?.message || e}`); } catch {}
      return;
    }

    _exportPresetState.lastPresetPath = String(res.path || "");
    _setPresetFeedbackTimed(`Imported: ${path.basename(String(res.path || "preset"))}`, "ok", 2200);
    await _applyPresetV1(snapshot, parsed);
  } catch (e) {
    _setPresetFeedbackTimed(`Error: ${e?.message || e}`, "error", 5200);
  } finally {
    _setPresetActionButtonsBusy(false);
  }
}


function _syncExportUiControls() {
  const typeTxt = el("btnExportTypeTxt");
  const typeJson = el("btnExportTypeJson");
  if (typeTxt) typeTxt.classList.toggle("active", _exportUi.type === "txt");
  if (typeJson) typeJson.classList.toggle("active", _exportUi.type === "json");

  const cCompact = el("btnContentCompact");
  const cStandard = el("btnContentStandard");
  const cFull = el("btnContentFull");
  if (cCompact) cCompact.classList.toggle("active", _exportUi.contentLevel === "compact");
  if (cStandard) cStandard.classList.toggle("active", _exportUi.contentLevel === "standard");
  if (cFull) cFull.classList.toggle("active", _exportUi.contentLevel === "full");

  const oTree = el("optTreeHeader");
  const oIgnored = el("optIgnoredSummary");
  const oHashes = el("optHashes");
  const oSort = el("optSortDet");
  if (oTree) oTree.checked = Boolean(_exportUi.options.treeHeader);
  if (oIgnored) oIgnored.checked = Boolean(_exportUi.options.ignoredSummary);
  if (oHashes) oHashes.checked = Boolean(_exportUi.options.hashes);
  if (oSort) oSort.checked = Boolean(_exportUi.options.sortDet);
}

function _updateExportLiveSummary(snapshot) {
  const elSum = el("exportLiveSummary");
  if (!elSum) return;
  const activeSnapshot = snapshot || lastSnapshot || {};
  const profile = _buildExportProfile();
  const mode = profile.scope === "selected" ? "Selected" : "All";
  const selected = _exportSelectionState.selected.size;
  const resolvedSet = profile.scope === "selected"
    ? _collectExportableFromSelection(activeSnapshot)
    : _collectExportableAll(activeSnapshot);
  const resolvedAbs = Array.from(resolvedSet || []);
  const resolved = resolvedAbs.length;

  _scheduleExportSizeRecalc(activeSnapshot, profile, resolvedAbs);

  const showBytes = _exportSizeState.status === "ready"
    ? _exportSizeState.bytes
    : (_exportSizeState.status === "error" ? _exportSizeState.lastStableBytes : null);
  const sizeText = _formatArchiveSizeText(_exportSizeState.status, showBytes, _exportSizeState.status === "error");
  elSum.textContent = `Mode: ${mode} · Selected: ${selected} · Resolved files: ${resolved} · Format: ${String(profile.format || "txt").toUpperCase()} · Tree: ${profile.include_tree ? "yes" : "no"} · Export archive size: ${sizeText}`;
}

async function _runExportByType(type) {
  const t = String(type || _exportUi.type || "txt").toLowerCase();
  if (t === "json") {
    showToast("Exporting JSON…", { type: "info", ttl: 1800 });
    await ipcRenderer.invoke("export:json");
    return;
  }
  showToast("Exporting TXT…", { type: "info", ttl: 1800 });
  await ipcRenderer.invoke("export:txt");
}

function _buildFileRow(r, snapshot) {
  const row = document.createElement("div");
  const picked = _isSelectedPath(r.absPath);
  row.className = "row" + (r.id === selectedId ? " selected" : "") + (r.ignored ? " ignored" : "") + (picked ? " row-picked" : "");

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
      <input type="checkbox" class="rowPick" data-select="1" aria-label="Select for export" ${picked ? "checked" : ""} ${r.ignored ? "disabled" : ""} />
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
      (target.closest("[data-select]") || target.closest("[data-caret]") || target.closest("[data-eye]") || target.closest("[data-view]"))
    )
      return;
    selectedId = r.id;
    render(snapshot);
  });

  row.querySelector("[data-select]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (r.ignored) return;
    const p = _normalizeAbsPath(r.absPath);
    if (r.isDir) {
      const descendants = _collectDescendantsFromSnapshot(snapshot, p);
      const isSelecting = !_exportSelectionState.selected.has(p);
      _applyFolderSelection(_exportSelectionState.selected, p, isSelecting, descendants);
    } else {
      _toggleSelectedPath(p);
    }
    _updateExportSelectionMeta(snapshot);
    render(snapshot);
  });

  row.querySelector("[data-caret]")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!r.isDir) return;
    const folderPath = _normalizeAbsPath(r.absPath);
    if (expanded.has(r.id)) {
      expanded.delete(r.id);
      expandedPaths.delete(folderPath);
    } else {
      expanded.add(r.id);
      expandedPaths.add(folderPath);
    }
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
      (target.closest("[data-select]") || target.closest("[data-caret]") || target.closest("[data-eye]") || target.closest("[data-view]"))
    )
      return;

    // comportamento atual: duplo clique alterna ignore/unignore
    await ipcRenderer.invoke("tree:toggleIgnored", r.absPath);
  });

  return row;
}

function _renderVirtualFileRows(list, rows, snapshot) {
  const total = rows.length;
  const rowH = Math.max(28, _fileListVirtual.rowHeight || 40);
  const viewportH = Math.max(1, list.clientHeight || 1);
  const scrollTop = Math.max(0, list.scrollTop || 0);
  const { start, end } = _virtualRange(total, rowH, viewportH, scrollTop, _fileListVirtual.overscan);

  const topPad = document.createElement("div");
  topPad.style.height = `${Math.max(0, start * rowH)}px`;
  topPad.setAttribute("aria-hidden", "true");

  const bottomPad = document.createElement("div");
  bottomPad.style.height = `${Math.max(0, (total - end) * rowH)}px`;
  bottomPad.setAttribute("aria-hidden", "true");

  const frag = document.createDocumentFragment();
  frag.appendChild(topPad);
  for (let i = start; i < end; i++) {
    frag.appendChild(_buildFileRow(rows[i], snapshot));
  }
  frag.appendChild(bottomPad);

  list.innerHTML = "";
  list.appendChild(frag);

  // Keep row height estimate in sync with real rendered row size.
  const firstRow = list.querySelector(".row");
  if (firstRow) {
    const measured = Math.round(firstRow.getBoundingClientRect().height);
    if (measured >= 28 && measured <= 96) _fileListVirtual.rowHeight = measured;
  }
}

function _rerenderVirtualFileList() {
  const list = el("fileList");
  if (!list) return;
  if (!_fileRowsSnapshot) return;
  _renderVirtualFileRows(list, _fileRowsCache || [], _fileRowsSnapshot);
}

function _bindFileListVirtualEvents() {
  if (_fileListVirtual.bound) return;
  const list = el("fileList");
  if (!list) return;
  _fileListVirtual.bound = true;

  list.addEventListener(
    "scroll",
    () => {
      if (_fileListVirtual.scrollRAF) return;
      _fileListVirtual.scrollRAF = requestAnimationFrame(() => {
        _fileListVirtual.scrollRAF = 0;
        _rerenderVirtualFileList();
      });
    },
    { passive: true }
  );

  window.addEventListener("resize", () => {
    if (_fileListVirtual.resizeRAF) return;
    _fileListVirtual.resizeRAF = requestAnimationFrame(() => {
      _fileListVirtual.resizeRAF = 0;
      _rerenderVirtualFileList();
    });
  });
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
  _cleanupSelectionWithSnapshot(snapshot);

  el("projectPath").textContent = snapshot.projectPath || "No folder opened";
  el("itemsCount").textContent = `${snapshot.stats.items} items`;
  _updateItemsCount(snapshot, null);
  el("statusLine").textContent = snapshot.status || "Ready.";
  const chkSelectedOnly = el("chkExportSelectedOnly");
  if (chkSelectedOnly) chkSelectedOnly.checked = _exportSelectionState.selectedMode === "selected";
  const chkSelectedOnlyTab = el("chkExportSelectedOnlyTab");
  if (chkSelectedOnlyTab) chkSelectedOnlyTab.checked = _exportSelectionState.selectedMode === "selected";
  _syncExportUiControls();

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

  if (!snapshot.tree) {
    _fileRowsCache = [];
    _fileRowsSnapshot = null;
    return;
  }

  _cleanupExpandedPathsFromTree(snapshot.tree);
  syncExpandedIdsFromPaths(snapshot.tree);

  const rows = [];
  const searchMode = _fileSearchMode(filesSearchQuery);
  if (searchMode) {
    for (const ch of snapshot.tree.children || []) {
      flattenTreeFiltered(ch, 0, rows, ignoredSet, searchMode);
    }
  } else {
    for (const ch of snapshot.tree.children || []) {
      flattenTree(ch, 0, rows, ignoredSet);
    }
  }

  _updateItemsCount(snapshot, rows.length);

  _fileRowsCache = rows;
  _fileRowsSnapshot = snapshot;
  _renderVirtualFileRows(list, rows, snapshot);
  _updateExportSelectionMeta(snapshot);

  if (!_exportPresetState.applying) {
    if (_exportPresetState.lastPresetPath) {
      _setPresetFeedback(`Preset file: ${path.basename(_exportPresetState.lastPresetPath)}`, "none");
    } else {
      _setPresetFeedback("Preset: idle", "none");
    }
  }
}

function _previewActionLabel(action) {
  const a = String(action || "").toLowerCase();
  if (a.includes("create") || a.includes("add") || a.includes("new")) return "ADD";
  if (a.includes("delete") || a.includes("remove")) return "DEL";
  if (a.includes("modify") || a.includes("update") || a.includes("change")) return "MOD";
  return "CHG";
}

function _previewActionClass(action) {
  const a = _previewActionLabel(action);
  if (a === "ADD") return "add";
  if (a === "DEL") return "del";
  return "mod";
}

function _normalizePreviewFiles(preview) {
  const src = Array.isArray(preview?.files)
    ? preview.files
    : Array.isArray(preview?.changes)
    ? preview.changes
    : [];

  const out = [];
  const seen = new Set();
  for (const item of src) {
    const p = String(item?.path || "").trim();
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push({
      path: p,
      action: _previewActionLabel(item?.action),
      beforeText: typeof item?.beforeText === "string" ? item.beforeText : "",
      afterText: typeof item?.afterText === "string" ? item.afterText : "",
      diffText: typeof item?.diffText === "string" ? item.diffText : "",
      hasBefore: Boolean(item?.hasBefore),
      hasAfter: Boolean(item?.hasAfter),
      beforeSource: typeof item?.beforeSource === "string" ? item.beforeSource : "",
      afterSource: typeof item?.afterSource === "string" ? item.afterSource : "",
    });
  }
  return out;
}

function _logApplyPreviewSummary(preview) {
  if (!preview || typeof preview !== "object") return;

  addLog(
    `[APPLY_PREVIEW] exit=${preview.exitCode ?? "?"} changes=${preview.changesCount ?? 0} errors=${
      preview.errorsCount ?? 0
    } rejects=${preview.rejectsCount ?? 0}`
  );

  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  const take = changes.slice(0, 20);
  for (const c of take) {
    addLog(`[APPLY_PREVIEW] ${_previewActionLabel(c?.action)} ${c?.path || "(unknown)"}`);
  }
  if (changes.length > take.length) {
    addLog(`[APPLY_PREVIEW] ... +${changes.length - take.length} more`);
  }

  if (preview.reportPath) addLog(`[APPLY_PREVIEW] report: ${preview.reportPath}`);
  if (preview.summaryPath) addLog(`[APPLY_PREVIEW] summary: ${preview.summaryPath}`);
}

function _buildApplyPreviewConfirmText(preview) {
  const lines = [];
  lines.push("Apply preview completed (Plan mode).");
  lines.push(`Potential changes: ${preview.changesCount ?? 0}`);
  lines.push(`Errors: ${preview.errorsCount ?? 0}`);
  lines.push(`Rejects: ${preview.rejectsCount ?? 0}`);

  const changes = Array.isArray(preview.changes) ? preview.changes : [];
  if (changes.length) {
    lines.push("");
    lines.push("Sample affected files:");
    for (const c of changes.slice(0, 8)) {
      lines.push(`- [${_previewActionLabel(c?.action)}] ${c?.path || "(unknown)"}`);
    }
    if (changes.length > 8) lines.push(`- ... +${changes.length - 8} more`);
  }

  lines.push("");
  lines.push("Proceed with Run Apply?");
  return lines.join("\n");
}

// ─────────────────────────────────────────────
// Wire buttons / UI actions
function _setApplyDiffOpen(open) {
  const modal = el("applyDiffModal");
  if (!modal) return;
  _applyDiffState.open = !!open;
  modal.hidden = !open;
  modal.setAttribute("aria-hidden", open ? "false" : "true");
  document.body.classList.toggle("has-apply-diff", !!open);
}

function _setApplyDiffBusy(busy) {
  _applyDiffState.busy = !!busy;
  const runBtn = el("btnApplyDiffRunApply");
  const refreshBtn = el("btnApplyDiffRefresh");
  const cancelBtn = el("btnApplyDiffCancel");
  if (runBtn) runBtn.disabled = !!busy || !_applyDiffState.preview?.ok;
  if (refreshBtn) refreshBtn.disabled = !!busy;
  if (cancelBtn) cancelBtn.disabled = !!busy;
}

function _applyDiffMatches(file, search) {
  const s = String(search || "").trim().toLowerCase();
  if (!s) return true;
  return file.path.toLowerCase().includes(s) || String(file.action || "").toLowerCase().includes(s);
}

function _renderApplyDiffFileList() {
  const host = el("applyDiffFileList");
  if (!host) return;
  host.innerHTML = "";

  const search = el("applyDiffSearch")?.value || "";
  const files = _applyDiffState.files.filter((f) => _applyDiffMatches(f, search));
  _applyDiffState.filtered = files;

  if (!files.length) {
    const div = document.createElement("div");
    div.className = "applyDiffEmpty";
    div.textContent = "No files match the current filter.";
    host.appendChild(div);
    return;
  }

  let activePath = _applyDiffState.selectedPath;
  if (!activePath || !files.some((f) => f.path === activePath)) {
    activePath = files[0].path;
    _applyDiffState.selectedPath = activePath;
  }

  for (const file of files) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "applyDiffFileRow" + (file.path === activePath ? " active" : "");
    btn.addEventListener("click", () => {
      _applyDiffState.selectedPath = file.path;
      _renderApplyDiffFileList();
      _renderApplyDiffViewer();
    });

    const badge = document.createElement("span");
    badge.className = `diffBadge diffBadge-${_previewActionClass(file.action)}`;
    badge.textContent = _previewActionLabel(file.action);
    btn.appendChild(badge);

    const name = document.createElement("span");
    name.className = "applyDiffFilePath mono";
    name.textContent = file.path;
    btn.appendChild(name);

    host.appendChild(btn);
  }
}

function _splitDiffLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").split("\n");
}

function _clipDiffRows(rows, maxRows = 4500) {
  if (rows.length <= maxRows) return rows;
  const out = rows.slice(0, maxRows);
  out.push({
    leftNo: "",
    rightNo: "",
    leftText: "... diff truncated ...",
    rightText: "... diff truncated ...",
    leftKind: "mod",
    rightKind: "mod",
  });
  return out;
}

function _buildRowsFromUnifiedDiff(diffText) {
  const rows = [];
  const lines = _splitDiffLines(diffText);
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  let pendingDel = [];

  const flushPendingDel = () => {
    while (pendingDel.length) {
      const d = pendingDel.shift();
      rows.push({
        leftNo: d.no,
        rightNo: "",
        leftText: d.text,
        rightText: "",
        leftKind: "del",
        rightKind: "empty",
      });
    }
  };

  for (const line of lines) {
    const hunk = line.match(/^@@\s+\-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      flushPendingDel();
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (line.startsWith("diff --git ")) {
      flushPendingDel();
      inHunk = false;
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("\\ No newline")) continue;

    if (line.startsWith("-")) {
      pendingDel.push({ no: oldNo, text: line.slice(1) });
      oldNo += 1;
      continue;
    }

    if (line.startsWith("+")) {
      const addNo = newNo;
      const addText = line.slice(1);
      newNo += 1;
      if (pendingDel.length) {
        const d = pendingDel.shift();
        rows.push({
          leftNo: d.no,
          rightNo: addNo,
          leftText: d.text,
          rightText: addText,
          leftKind: "mod",
          rightKind: "mod",
        });
      } else {
        rows.push({
          leftNo: "",
          rightNo: addNo,
          leftText: "",
          rightText: addText,
          leftKind: "empty",
          rightKind: "add",
        });
      }
      continue;
    }

    if (line.startsWith(" ")) {
      flushPendingDel();
      rows.push({
        leftNo: oldNo,
        rightNo: newNo,
        leftText: line.slice(1),
        rightText: line.slice(1),
        leftKind: "ctx",
        rightKind: "ctx",
      });
      oldNo += 1;
      newNo += 1;
      continue;
    }
  }

  flushPendingDel();
  return _clipDiffRows(rows);
}

function _flushPendingDiffChunks(rows, dels, adds) {
  while (dels.length || adds.length) {
    if (dels.length && adds.length) {
      const d = dels.shift();
      const a = adds.shift();
      rows.push({
        leftNo: d.no,
        rightNo: a.no,
        leftText: d.text,
        rightText: a.text,
        leftKind: "mod",
        rightKind: "mod",
      });
      continue;
    }
    if (dels.length) {
      const d = dels.shift();
      rows.push({
        leftNo: d.no,
        rightNo: "",
        leftText: d.text,
        rightText: "",
        leftKind: "del",
        rightKind: "empty",
      });
      continue;
    }
    const a = adds.shift();
    rows.push({
      leftNo: "",
      rightNo: a.no,
      leftText: "",
      rightText: a.text,
      leftKind: "empty",
      rightKind: "add",
    });
  }
}

function _buildRowsFromTexts(beforeText, afterText, action) {
  const rows = [];
  const before = _splitDiffLines(beforeText);
  const after = _splitDiffLines(afterText);
  const kind = _previewActionLabel(action);

  if (kind === "ADD" && after.length) {
    for (let i = 0; i < after.length; i++) {
      rows.push({
        leftNo: "",
        rightNo: i + 1,
        leftText: "",
        rightText: after[i],
        leftKind: "empty",
        rightKind: "add",
      });
    }
    return _clipDiffRows(rows);
  }

  if (kind === "DEL" && before.length) {
    for (let i = 0; i < before.length; i++) {
      rows.push({
        leftNo: i + 1,
        rightNo: "",
        leftText: before[i],
        rightText: "",
        leftKind: "del",
        rightKind: "empty",
      });
    }
    return _clipDiffRows(rows);
  }

  const n = before.length;
  const m = after.length;
  if (!n && !m) return [];

  // Avoid heavy matrices for very large files.
  const CELL_LIMIT = 1200000;
  if (n * m > CELL_LIMIT) {
    const maxLen = Math.max(n, m);
    for (let i = 0; i < maxLen; i++) {
      const hasLeft = i < n;
      const hasRight = i < m;
      rows.push({
        leftNo: hasLeft ? i + 1 : "",
        rightNo: hasRight ? i + 1 : "",
        leftText: hasLeft ? before[i] : "",
        rightText: hasRight ? after[i] : "",
        leftKind: hasLeft && hasRight ? (before[i] === after[i] ? "ctx" : "mod") : hasLeft ? "del" : "empty",
        rightKind: hasLeft && hasRight ? (before[i] === after[i] ? "ctx" : "mod") : hasRight ? "add" : "empty",
      });
    }
    return _clipDiffRows(rows);
  }

  const cols = m + 1;
  const dp = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const idx = i * cols + j;
      if (before[i] === after[j]) {
        dp[idx] = dp[(i + 1) * cols + (j + 1)] + 1;
      } else {
        const down = dp[(i + 1) * cols + j];
        const right = dp[i * cols + (j + 1)];
        dp[idx] = down >= right ? down : right;
      }
    }
  }

  let i = 0;
  let j = 0;
  const pendingDel = [];
  const pendingAdd = [];

  while (i < n || j < m) {
    if (i < n && j < m && before[i] === after[j]) {
      _flushPendingDiffChunks(rows, pendingDel, pendingAdd);
      rows.push({
        leftNo: i + 1,
        rightNo: j + 1,
        leftText: before[i],
        rightText: after[j],
        leftKind: "ctx",
        rightKind: "ctx",
      });
      i += 1;
      j += 1;
      continue;
    }

    const down = i < n ? dp[(i + 1) * cols + j] : 0;
    const right = j < m ? dp[i * cols + (j + 1)] : 0;
    if (j < m && (i >= n || right >= down)) {
      pendingAdd.push({ no: j + 1, text: after[j] });
      j += 1;
      continue;
    }
    if (i < n) {
      pendingDel.push({ no: i + 1, text: before[i] });
      i += 1;
    }
  }

  _flushPendingDiffChunks(rows, pendingDel, pendingAdd);
  return _clipDiffRows(rows);
}

function _looksUnifiedDiff(diffText) {
  const s = String(diffText || "");
  if (!s) return false;
  if (/^@@\s+\-\d+/m.test(s)) return true;
  if (/^diff --git /m.test(s)) return true;
  if (/^(---|\+\+\+) /m.test(s)) return true;
  return false;
}

function _buildRowsForPreviewFile(file) {
  const beforeText = typeof file?.beforeText === "string" ? file.beforeText : "";
  const afterText = typeof file?.afterText === "string" ? file.afterText : "";
  const diffText = typeof file?.diffText === "string" ? file.diffText : "";
  const action = _previewActionLabel(file?.action || "MOD");
  const hasBefore = Boolean(file?.hasBefore || beforeText);
  const hasAfter = Boolean(file?.hasAfter || afterText);

  if (_looksUnifiedDiff(diffText)) {
    const rowsByDiff = _buildRowsFromUnifiedDiff(diffText);
    if (rowsByDiff.length) return rowsByDiff;
  }

  if (action === "ADD" && hasAfter) {
    return _buildRowsFromTexts("", afterText, "ADD");
  }
  if (action === "DEL" && hasBefore) {
    return _buildRowsFromTexts(beforeText, "", "DEL");
  }
  if (hasBefore && hasAfter) {
    return _buildRowsFromTexts(beforeText, afterText, "MOD");
  }

  return [];
}

function _isLikelyNewFilePreview(file) {
  const action = _previewActionLabel(file?.action || "MOD");
  if (action === "ADD") return true;

  const hasBefore = Boolean(file?.hasBefore || file?.beforeText);
  const hasAfter = Boolean(file?.hasAfter || file?.afterText);
  if (!hasBefore && hasAfter) return true;

  const diffText = String(file?.diffText || "");
  if (!diffText) return false;
  if (/^new file mode\b/m.test(diffText)) return true;
  if (/^@@\s+\-0(?:,0)?\s+\+\d+(?:,\d+)?\s+@@/m.test(diffText)) return true;
  return false;
}

function _renderDiffColumn(container, rows, side) {
  if (!container) return;
  container.innerHTML = "";
  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const kind = side === "left" ? row.leftKind : row.rightKind;
    const no = side === "left" ? row.leftNo : row.rightNo;
    const text = side === "left" ? row.leftText : row.rightText;

    const line = document.createElement("div");
    line.className = `applyDiffLine applyDiffLine-${kind || "ctx"}`;

    const ln = document.createElement("div");
    ln.className = "applyDiffLn";
    ln.textContent = no ? String(no) : "";
    line.appendChild(ln);

    const tx = document.createElement("pre");
    tx.className = "applyDiffTxt";
    tx.textContent = String(text || "");
    line.appendChild(tx);

    frag.appendChild(line);
  }
  container.appendChild(frag);
}

function _syncDiffScroll(beforeEl, afterEl) {
  if (!beforeEl || !afterEl) return;
  let lock = false;
  beforeEl.onscroll = () => {
    if (lock) return;
    lock = true;
    afterEl.scrollTop = beforeEl.scrollTop;
    afterEl.scrollLeft = beforeEl.scrollLeft;
    requestAnimationFrame(() => {
      lock = false;
    });
  };
  afterEl.onscroll = () => {
    if (lock) return;
    lock = true;
    beforeEl.scrollTop = afterEl.scrollTop;
    beforeEl.scrollLeft = afterEl.scrollLeft;
    requestAnimationFrame(() => {
      lock = false;
    });
  };
}

function _renderApplyDiffViewer() {
  const beforeEl = el("applyDiffBefore");
  const afterEl = el("applyDiffAfter");
  const fallback = el("applyDiffFallback");
  const pathLine = el("applyDiffPathLine");
  const metaLine = el("applyDiffMetaLine");
  const grid = el("applyDiffGrid");
  const panes = grid ? Array.from(grid.querySelectorAll(".applyDiffPane")) : [];
  const beforePane = panes[0] || null;
  const afterPane = panes[1] || null;
  if (!beforeEl || !afterEl || !fallback || !pathLine || !metaLine) return;

  const setSingleAfterMode = (on) => {
    if (!grid) return;
    const single = !!on;
    grid.classList.toggle("single-after", single);
    if (beforePane) beforePane.hidden = single;
    if (afterPane) afterPane.hidden = false;
  };

  beforeEl.onscroll = null;
  afterEl.onscroll = null;

  const file = _applyDiffState.filtered.find((f) => f.path === _applyDiffState.selectedPath) || null;
  if (!file) {
    setSingleAfterMode(false);
    beforeEl.innerHTML = "";
    afterEl.innerHTML = "";
    fallback.hidden = false;
    fallback.textContent = "No file selected.";
    pathLine.textContent = "(no file selected)";
    metaLine.textContent = "";
    return;
  }

  pathLine.textContent = file.path;
  const beforeSrc = file.beforeSource ? ` before:${file.beforeSource}` : "";
  const afterSrc = file.afterSource ? ` after:${file.afterSource}` : "";
  metaLine.textContent = `${file.action} | before=${file.beforeText.length} chars | after=${file.afterText.length} chars${beforeSrc}${afterSrc}`;

  const isNewFile = _isLikelyNewFilePreview(file);
  setSingleAfterMode(isNewFile);

  const rows = _buildRowsForPreviewFile(file);
  if (rows.length) {
    _renderDiffColumn(beforeEl, rows, "left");
    _renderDiffColumn(afterEl, rows, "right");
    fallback.hidden = true;
    fallback.textContent = "";
    if (!isNewFile) _syncDiffScroll(beforeEl, afterEl);
    return;
  }

  beforeEl.innerHTML = "";
  afterEl.innerHTML = "";
  fallback.hidden = false;
  fallback.textContent =
    file.diffText ||
    "(No structured diff available for this file. Use Refresh Preview to re-read report/summary.)";
}

function _renderApplyDiffModal() {
  const preview = _applyDiffState.preview || {};
  const summary = el("applyDiffSummaryLine");
  if (summary) {
    const status = preview.ok ? "Preview OK" : "Preview blocked";
    summary.textContent =
      `${status} | files=${_applyDiffState.files.length} | errors=${preview.errorsCount ?? 0} | rejects=${
        preview.rejectsCount ?? 0
      }` + (preview.exitCode !== undefined ? ` | exit=${preview.exitCode}` : "");
  }

  _renderApplyDiffFileList();
  _renderApplyDiffViewer();
  _setApplyDiffBusy(_applyDiffState.busy);
}

function _openApplyDiffModal(preview) {
  _applyDiffState.preview = preview || null;
  _applyDiffState.files = _normalizePreviewFiles(preview);
  _applyDiffState.filtered = _applyDiffState.files.slice();
  _applyDiffState.selectedPath = _applyDiffState.files[0]?.path || "";
  const search = el("applyDiffSearch");
  if (search) search.value = "";
  _setApplyDiffOpen(true);
  _setApplyDiffBusy(false);
  _renderApplyDiffModal();
  try {
    el("applyDiffSearch")?.focus();
  } catch {}
}

function _closeApplyDiffModal() {
  _setApplyDiffOpen(false);
}

async function _invokeApplyPreview(sourceTag) {
  const tag = sourceTag || "preview";
  const nonce = ++_applyDiffPreviewNonce;
  setPatchBusy(true, "plan");
  _applyDiffState.busy = true;
  _renderApplyDiffModal();
  addLog(`[APPLY_PREVIEW] start (${tag})`);

  let preview = null;
  try {
    preview = await ipcRenderer.invoke("patch:previewApply", { pipelinePath: currentPipelinePath });
  } catch (e) {
    if (nonce !== _applyDiffPreviewNonce) return null;
    addLog(`[APPLY_PREVIEW] invoke error: ${e?.message || e}`);
    showToast("Apply preview failed.", { type: "error", ttl: 3600 });
    setPatchBusy(false);
    _applyDiffState.busy = false;
    _renderApplyDiffModal();
    return null;
  }

  if (nonce !== _applyDiffPreviewNonce) return null;
  _logApplyPreviewSummary(preview);
  setPatchBusy(false);
  _applyDiffState.busy = false;
  return preview;
}

async function _runPreviewAndOpenDiffModal(sourceTag) {
  showToast("Previewing changes before Apply...", { type: "info", ttl: 1800 });
  const preview = await _invokeApplyPreview(sourceTag || "run-apply");
  if (!preview) return;

  _openApplyDiffModal(preview);

  if (!preview.ok) {
    const reason = preview?.error || `exit=${preview?.exitCode ?? "?"}`;
    addLog(`[APPLY_PREVIEW] blocked: ${reason}`);
    showToast("Apply blocked: preview reported issues.", { type: "error", ttl: 4200 });
    return;
  }

  showToast(`Preview ready: ${_applyDiffState.files.length} potential change(s).`, {
    type: "warn",
    ttl: 2800,
  });
}

async function _refreshPreviewInDiffModal() {
  if (!_applyDiffState.open || _applyDiffState.busy) return;
  showToast("Refreshing preview...", { type: "info", ttl: 1400 });
  const preview = await _invokeApplyPreview("refresh");
  if (!preview) return;

  _applyDiffState.preview = preview;
  _applyDiffState.files = _normalizePreviewFiles(preview);
  _applyDiffState.filtered = _applyDiffState.files.slice();
  if (!_applyDiffState.files.some((f) => f.path === _applyDiffState.selectedPath)) {
    _applyDiffState.selectedPath = _applyDiffState.files[0]?.path || "";
  }
  _renderApplyDiffModal();
  if (preview.ok) showToast("Preview refreshed.", { type: "success", ttl: 1600 });
  else showToast("Preview refreshed with issues.", { type: "warn", ttl: 2200 });
}

async function _confirmApplyFromDiffModal() {
  if (_applyDiffState.busy) return;
  const preview = _applyDiffState.preview;
  if (!preview || !preview.ok) {
    showToast("Apply is blocked until preview is valid.", { type: "error", ttl: 3200 });
    return;
  }

  addLog("[APPLY_PREVIEW] apply confirmed by user");
  _closeApplyDiffModal();
  setPatchBusy(true, "apply");
  showToast("Running Apply...", { type: "info", ttl: 1600 });
  try {
    await ipcRenderer.invoke("patch:runPipeline", { mode: "apply", pipelinePath: currentPipelinePath });
  } catch (e) {
    setPatchBusy(false);
    throw e;
  }
}

function bind() {
  _loadExportUiConfig();
  try{
    const prof = _buildExportProfile();
    _exportSelectionState.selectedMode = prof.scope === "selected" ? "selected" : "all";
  }catch{}
  setTabs();
  _refreshPresetControlsUi();
  _bindFileListVirtualEvents();

  const filesSearchInput = el("filesSearchInput");
  const filesSearchClear = el("filesSearchClear");

  filesSearchInput?.addEventListener("input", () => {
    const value = filesSearchInput.value || "";
    if (filesSearchDebounceTimer) clearTimeout(filesSearchDebounceTimer);
    filesSearchDebounceTimer = setTimeout(() => {
      _setFilesSearchQuery(value);
    }, 200);
  });

  filesSearchInput?.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    if (!filesSearchInput.value && !filesSearchQuery) return;
    ev.preventDefault();
    if (filesSearchDebounceTimer) clearTimeout(filesSearchDebounceTimer);
    _setFilesSearchQuery("");
  });

  filesSearchClear?.addEventListener("click", () => {
    if (filesSearchDebounceTimer) clearTimeout(filesSearchDebounceTimer);
    _setFilesSearchQuery("");
    filesSearchInput?.focus();
  });

  _updateFilesSearchUi();

  _bindClickSafe("btnOpen", async () => {
    await ipcRenderer.invoke("project:open");
  });

  _bindClickSafe("btnRefreshFiles", async () => {
    const b = el("btnRefreshFiles");
    if (b?.classList?.contains("busy")) return;

    try {
      b?.classList?.add("busy");
      _markPresetRefreshCycle();
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

  _bindClickSafe("btnHelp", async () => {
    await ipcRenderer.invoke("ui:help");
  });

  _bindClickSafe("btnClearIgnored", async () => {
    await ipcRenderer.invoke("tree:clearIgnored");
  });

  el("chkExportSelectedOnly")?.addEventListener("change", (e) => {
    _exportSelectionState.selectedMode = e?.target?.checked ? "selected" : "all";
    const tabChk = el("chkExportSelectedOnlyTab");
    if (tabChk) tabChk.checked = Boolean(e?.target?.checked);
    _updateExportSelectionMeta(lastSnapshot);
    if (lastSnapshot?.projectPath) _writeExportSelectionConfig(lastSnapshot);
  });

  el("chkExportSelectedOnlyTab")?.addEventListener("change", (e) => {
    const mainChk = el("chkExportSelectedOnly");
    if (mainChk) {
      mainChk.checked = Boolean(e?.target?.checked);
      mainChk.dispatchEvent(new Event("change"));
      return;
    }
    _exportSelectionState.selectedMode = e?.target?.checked ? "selected" : "all";
    _updateExportSelectionMeta(lastSnapshot);
    if (lastSnapshot?.projectPath) _writeExportSelectionConfig(lastSnapshot);
  });

  el("btnSelectAllVisible")?.addEventListener("click", () => {
    const snapshot = lastSnapshot;
    if (!snapshot) return;
    const ignoredSet = new Set(snapshot.ignored || []);
    for (const r of _fileRowsCache || []) {
      if (ignoredSet.has(r.absPath)) continue;
      _exportSelectionState.selected.add(_normalizeAbsPath(r.absPath));
    }
    _updateExportSelectionMeta(snapshot);
    render(snapshot);
  });

  el("btnClearSelection")?.addEventListener("click", () => {
    _exportSelectionState.selected.clear();
    _updateExportSelectionMeta(lastSnapshot);
    if (lastSnapshot) render(lastSnapshot);
  });

  el("btnSelectAllVisibleTab")?.addEventListener("click", () => {
    el("btnSelectAllVisible")?.click();
  });

  el("btnClearSelectionTab")?.addEventListener("click", () => {
    el("btnClearSelection")?.click();
  });

  const _setExportType = (t) => {
    _exportUi.type = t === "json" ? "json" : "txt";
    _syncExportUiControls();
    _updateExportLiveSummary(lastSnapshot);
    _saveExportUiConfig();
  };

  el("btnExportTypeTxt")?.addEventListener("click", () => _setExportType("txt"));
  el("btnExportTypeJson")?.addEventListener("click", () => _setExportType("json"));

  const _setContentLevel = (lvl) => {
    if (!["compact", "standard", "full"].includes(lvl)) return;
    _exportUi.contentLevel = lvl;
    _syncExportUiControls();
    _updateExportLiveSummary(lastSnapshot);
    _saveExportUiConfig();
  };

  el("btnContentCompact")?.addEventListener("click", () => _setContentLevel("compact"));
  el("btnContentStandard")?.addEventListener("click", () => _setContentLevel("standard"));
  el("btnContentFull")?.addEventListener("click", () => _setContentLevel("full"));

  const _bindOpt = (id, key) => {
    el(id)?.addEventListener("change", (ev) => {
      _exportUi.options[key] = Boolean(ev?.target?.checked);
      _updateExportLiveSummary(lastSnapshot);
      _saveExportUiConfig();
    });
  };
  _bindOpt("optTreeHeader", "treeHeader");
  _bindOpt("optIgnoredSummary", "ignoredSummary");
  _bindOpt("optHashes", "hashes");
  _bindOpt("optSortDet", "sortDet");
  _syncExportUiControls();
  _updateExportLiveSummary(lastSnapshot);

  _bindClickSafe("btnPresetSaveFile", async () => {
    await _savePresetToFile(lastSnapshot);
  });

  _bindClickSafe("btnPresetImportFile", async () => {
    await _importPresetFromFile(lastSnapshot);
  });


  _bindClickSafe("btnExportTxt", async () => {
    const chk = el("chkExportSelectedOnly");
    if (chk) _exportSelectionState.selectedMode = chk.checked ? "selected" : "all";
    if (lastSnapshot) _cleanupSelectionWithSnapshot(lastSnapshot);
    if (lastSnapshot?.projectPath) _writeExportSelectionConfig(lastSnapshot);
    await _runExportByType("txt");
  });

  _bindClickSafe("btnExportJson", async () => {
    const chk = el("chkExportSelectedOnly");
    if (chk) _exportSelectionState.selectedMode = chk.checked ? "selected" : "all";
    if (lastSnapshot) _cleanupSelectionWithSnapshot(lastSnapshot);
    if (lastSnapshot?.projectPath) _writeExportSelectionConfig(lastSnapshot);
    await _runExportByType("json");
  });

  _bindClickSafe("btnExportPrimary", async () => {
    const tabChk = el("chkExportSelectedOnlyTab");
    const mainChk = el("chkExportSelectedOnly");
    if (mainChk && tabChk) mainChk.checked = Boolean(tabChk.checked);
    if (mainChk) {
      _exportSelectionState.selectedMode = mainChk.checked ? "selected" : "all";
    }
    if (lastSnapshot) _cleanupSelectionWithSnapshot(lastSnapshot);
    if (lastSnapshot?.projectPath) _writeExportSelectionConfig(lastSnapshot);
    await _runExportByType(_exportUi.type);
  });

  _bindClickSafe("btnCopyLogs", async () => {
    showToast("Logs copied.", { type: "success", ttl: 1600 });
    await ipcRenderer.invoke("logs:copy");
  });

  _bindClickSafe("btnClearLogs", async () => {
    await ipcRenderer.invoke("logs:clear");
  });

  // Patch tools
  _bindClickSafe("btnPickRunner", async () => {
    await ipcRenderer.invoke("patch:pickRunner");
  });

  _bindClickSafe("btnReloadManifest", async () => {
    await ipcRenderer.invoke("patch:reloadManifest");
  });

  _bindClickSafe("btnPickRw", async () => {
    const res = await ipcRenderer.invoke("patch:pickRw");
    // auto-generate pipeline from current selection
    const list = res?.valid || [];
    if (Array.isArray(list) && list.length) {
      const pipelineObj = await ipcRenderer.invoke("patch:generatePipeline", list);
      setPipelineText(pipelineObj);
    }
  });

  _bindClickSafe("btnClearRw", async () => {
    // limpar seleção só no renderer (mantém simples)
    if (!lastSnapshot) return;
    lastSnapshot.patch.selectedRws = [];
    lastSnapshot.patch.rejectedRws = [];
    render(lastSnapshot);
    setPipelineText(null);
    currentPipelinePath = null;
    el("pipelinePathLine").textContent = `Pipeline: (not saved)`;
  });

  _bindClickSafe("btnSavePipeline", async () => {
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

  _bindClickSafe("btnRunPlan", async () => {
    setPatchBusy(true, "plan");

    showToast("Running Plan…", { type: "info", ttl: 1600 });
    try {
  await ipcRenderer.invoke("patch:runPipeline", { mode: "plan", pipelinePath: currentPipelinePath });
} catch (e) {
  setPatchBusy(false);
  throw e;
}
  });

  _bindClickSafe("btnRunApply", async () => {
    await _runPreviewAndOpenDiffModal("run-apply");
  });

  el("btnApplyDiffRefresh")?.addEventListener("click", async () => {
    await _refreshPreviewInDiffModal();
  });

  el("btnApplyDiffCancel")?.addEventListener("click", () => {
    addLog("[APPLY_PREVIEW] apply canceled by user");
    _closeApplyDiffModal();
    showToast("Apply canceled.", { type: "warn", ttl: 2000 });
  });

  el("btnApplyDiffRunApply")?.addEventListener("click", async () => {
    await _confirmApplyFromDiffModal();
  });

  el("applyDiffSearch")?.addEventListener("input", () => {
    _renderApplyDiffFileList();
    _renderApplyDiffViewer();
  });

  _bindClickSafe("btnStopPatch", async () => {
    showToast("Stopping patch…", { type: "warn", ttl: 1800 });
    await ipcRenderer.invoke("patch:stop");
  });

  // Keyboard: ESC behavior
  // - if topmost card is editing: ask to discard (visual confirm bar)
  // - otherwise: close topmost card
  window.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    if (_applyDiffState.open) {
      e.preventDefault();
      e.stopPropagation();
      addLog("[APPLY_PREVIEW] preview closed via ESC");
      _closeApplyDiffModal();
      return;
    }

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

  _refreshPresetControlsUi();
  _reportUiBindHealth();

}

// ─────────────────────────────────────────────
// IPC events
ipcRenderer.on("state:update", (_, snapshot) => {
  render(snapshot);
  _maybeAutoApplyPreset(snapshot);
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


if (__PM_UI_DEV__) {
  window.addEventListener("error", (ev) => {
    const msg = String(ev?.message || "unknown");
    if (msg.includes("is not defined")) {
      console.error("[UI FATAL] Undefined reference:", msg);
      try { _setPresetFeedbackTimed(`Error: ${msg}`, "error", 4200); } catch {}
    }
    _uiDevLog(`window error: ${ev?.message || "unknown"}`, ev?.error || null);
  });
  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev?.reason;
    const msg = String(reason?.message || reason || "");
    if (msg.includes("is not defined")) {
      console.error("[UI FATAL] Undefined reference:", msg);
      try { _setPresetFeedbackTimed(`Error: ${msg}`, "error", 4200); } catch {}
    }
    _uiDevLog("unhandled rejection", ev?.reason || null);
  });
}


if (__PM_UI_TRACE_CLICKS__) {
  window.addEventListener("pointerdown", (ev) => {
    try {
      const t = ev.target;
      const id = t?.id ? `#${t.id}` : (t?.className ? `.${String(t.className).split(/\s+/)[0]}` : t?.tagName || "unknown");
      _uiDevLog(`pointerdown target=${id}`);
    } catch {}
  }, true);
}


if (__PM_UI_DEV__) {
  let __uiDiagEnabled = false;
  let __uiDiagBox = null;
  let __uiDiagOutline = null;
  const _diagEnsure = () => {
    if (__uiDiagBox && __uiDiagOutline) return;
    __uiDiagBox = document.createElement("div");
    __uiDiagBox.style.cssText = "position:fixed;right:10px;bottom:10px;z-index:2147483647;padding:6px 8px;border-radius:8px;background:rgba(0,0,0,.82);color:#d1d5db;font:11px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;pointer-events:none;white-space:pre;display:none;";
    __uiDiagOutline = document.createElement("div");
    __uiDiagOutline.style.cssText = "position:fixed;z-index:2147483646;border:1px dashed #67e8f9;pointer-events:none;display:none;";
    document.body.appendChild(__uiDiagBox);
    document.body.appendChild(__uiDiagOutline);
  };
  const _diagUpdate = (target) => {
    if (!__uiDiagEnabled || !target || !(target instanceof Element)) return;
    _diagEnsure();
    const r = target.getBoundingClientRect();
    const cs = getComputedStyle(target);
    __uiDiagOutline.style.display = "block";
    __uiDiagOutline.style.left = `${r.left}px`;
    __uiDiagOutline.style.top = `${r.top}px`;
    __uiDiagOutline.style.width = `${Math.max(0, r.width)}px`;
    __uiDiagOutline.style.height = `${Math.max(0, r.height)}px`;
    __uiDiagBox.style.display = "block";
    __uiDiagBox.textContent = [
      `id: ${target.id || "(none)"}`,
      `class: ${(target.className || "").toString().trim() || "(none)"}`,
      `z-index: ${cs.zIndex || "auto"}`,
      `pointer-events: ${cs.pointerEvents || "auto"}`,
    ].join("\n");
  };
  window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey && ev.altKey && (ev.key === "d" || ev.key === "D"))) return;
    __uiDiagEnabled = !__uiDiagEnabled;
    _diagEnsure();
    if (!__uiDiagEnabled) {
      __uiDiagBox.style.display = "none";
      __uiDiagOutline.style.display = "none";
    }
    _uiDevLog(`diag-overlay ${__uiDiagEnabled ? "enabled" : "disabled"}`);
  }, true);
  window.addEventListener("mousemove", (ev) => _diagUpdate(ev.target), true);
}

// bootstrap
bind();
_markPresetRefreshCycle();
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
