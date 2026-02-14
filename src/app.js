// @context: export-preset-file save-dialog open-dialog apply-rehydrate feedback.
const { app, BrowserWindow, dialog, ipcMain, clipboard } = require("electron");
const path = require("path");
const fs = require("fs");
const { spawn } = require("child_process");

const { COLORS, nowTime, formatCount } = require("./config");
const core = require("./core");

/*
PM-SV-PATCH META
Version: pm-svpatch-main@2026.02.11-r2
Last-Edited: 2026-02-11
Contains: Electron main process (project scan/index, file read/write, patch runner integration).
Implemented in this version: (1) Auto-refresh watcher: fs.watch (recursive) + polling fallback; emits 'watcher:changed' to renderer (debounced, disabled during Patch).
*/

let win = null;
let patchProc = null;

const userDataDir = app.getPath("userData");
const settingsPath = path.join(userDataDir, "app-settings.json");

const state = {
  projectPath: null,
  tree: null,
  index: new Map(),
  ignored: new Set(),
  logs: [],
  patch: {
    selectedRws: [],
    rejectedRws: [],
    lastPipelinePath: null,
    runnerPath: null,
    manifestPath: null,
    manifest: null,
  },
};


// ─────────────────────────────────────────────
// Auto-refresh watcher (diff-safe: additive; reuses existing project:refresh flow via renderer)
// Why: keeps Files tree in sync when user edits/deletes files outside the app.
// Safety: debounced + disabled while Patch is running to avoid churn/log spam.
let _projWatch = null;
let _projWatchRoot = null;
let _projWatchDebounce = null;
let _projWatchLastEmitMs = 0;
let _projWatchFallbackTimer = null;
let _projWatchFallbackSig = "";

function _stopProjectWatcher() {
  try { if (_projWatch) _projWatch.close(); } catch {}
  _projWatch = null;
  _projWatchRoot = null;
  try { if (_projWatchDebounce) clearTimeout(_projWatchDebounce); } catch {}
  _projWatchDebounce = null;
  try { if (_projWatchFallbackTimer) clearInterval(_projWatchFallbackTimer); } catch {}
  _projWatchFallbackTimer = null;
  _projWatchFallbackSig = "";
}

function _emitWatcherChanged(reason) {
  if (!win) return;
  if (!state.projectPath) return;
  // avoid refresh while patch is writing (lots of file churn)
  if (patchProc) return;

  const nowMs = Date.now();
  // throttle hard (spikes of events when git checkout etc.)
  if (nowMs - _projWatchLastEmitMs < 900) return;
  _projWatchLastEmitMs = nowMs;

  try {
    win.webContents.send("watcher:changed", { reason: String(reason || "fs") });
  } catch {}
}

function _scheduleWatcherEmit(reason) {
  try { if (_projWatchDebounce) clearTimeout(_projWatchDebounce); } catch {}
  _projWatchDebounce = setTimeout(() => _emitWatcherChanged(reason), 450);
}

function _fallbackSigForRoot(rootAbs) {
  // Very cheap signature: root dir mtime + top-level entry count.
  // (Not perfect, but good enough as a fallback on platforms without recursive fs.watch)
  try {
    const st = fs.statSync(rootAbs);
    const n = fs.readdirSync(rootAbs).length;
    return String(st.mtimeMs) + ":" + String(n);
  } catch {
    return "";
  }
}

function _startProjectWatcher(rootAbs) {
  try {
    const abs = String(rootAbs || "");
    if (!abs) return;

    // restart if root changed
    if (_projWatchRoot && _projWatchRoot === abs) return;
    _stopProjectWatcher();
    _projWatchRoot = abs;

    // Try native watcher (best on Windows/macOS; recursive is supported on Windows/macOS)
    try {
      _projWatch = fs.watch(abs, { recursive: true }, (_evt, _file) => {
        // debounce into a single UI refresh request
        _scheduleWatcherEmit("fs.watch");
      });
      log("INFO", "Auto-refresh: watcher active (fs.watch).");
      return;
    } catch (e) {
      log("WARNING", `Auto-refresh: fs.watch unavailable, using fallback polling (${e.message || e}).`);
    }

    // Fallback: light polling
    _projWatchFallbackSig = _fallbackSigForRoot(abs);
    _projWatchFallbackTimer = setInterval(() => {
      if (!state.projectPath || patchProc) return;
      const sig = _fallbackSigForRoot(abs);
      if (sig && sig !== _projWatchFallbackSig) {
        _projWatchFallbackSig = sig;
        _scheduleWatcherEmit("poll");
      }
    }, 2500);
  } catch (e) {
    log("WARNING", `Auto-refresh: watcher start failed (${e.message || e}).`);
  }
}

// Stop watcher on app shutdown
try { app.on("before-quit", () => _stopProjectWatcher()); } catch {}


function log(level, msg) {
  const entry = { ts: nowTime(), level, msg: String(msg) };
  state.logs.push(entry);
  try {
    win?.webContents.send("log:append", `[${entry.ts}] [${entry.level}] ${entry.msg}`);
  } catch {}
}

function push(extra = {}) {
  if (!win) return;
  win.webContents.send("state:update", snapshot(extra));
}

function snapshot(extra = {}) {
  const stats = state.index
    ? core.computeStats(state)
    : { files: 0, folders: 0, ignoredFiles: 0, ignoredFolders: 0, selectedFiles: 0, items: 0 };

  return {
    projectPath: state.projectPath,
    tree: state.tree,
    ignored: Array.from(state.ignored),
    stats,
    status: extra.status || "Ready.",
    patch: {
      selectedRws: state.patch.selectedRws,
      rejectedRws: state.patch.rejectedRws,
      lastPipelinePath: state.patch.lastPipelinePath,
      running: Boolean(patchProc),

      runnerPath: state.patch.runnerPath,
      manifestPath: state.patch.manifestPath,
      manifest: state.patch.manifest,
    },
  };
}

function readSettings() {
  try {
    if (!fs.existsSync(settingsPath)) return {};
    const raw = fs.readFileSync(settingsPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeSettings(obj) {
  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(obj, null, 2), "utf-8");
  } catch (e) {
    log("WARNING", `Failed to save settings: ${e.message || e}`);
  }
}

function posixRel(p) {
  return String(p || "").replaceAll("\\", "/");
}

function ensureProjectOpen() {
  if (!state.projectPath) {
    log("ERROR", "Abra um projeto (Open) antes de usar Patch.");
    return false;
  }
  return true;
}

function splitLinesChunked(s) {
  return String(s).replace(/\r\n/g, "\n").split("\n");
}

async function pickProjectFolder() {
  const res = await dialog.showOpenDialog(win, { title: "Open folder", properties: ["openDirectory"] });
  if (res.canceled || !res.filePaths?.[0]) return null;
  return res.filePaths[0];
}

async function saveAs(defaultName, filters) {
  const res = await dialog.showSaveDialog(win, { title: "Save as", defaultPath: defaultName, filters });
  if (res.canceled || !res.filePath) return null;
  return res.filePath;
}

function safeReadJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw);
}

/**
 * Manifest discovery: prefer {dir}/sv_patch.manifest.json (fixed),
 * else try {runnerBase}.manifest.json
 */
function findManifestForRunner(runnerPath) {
  if (!runnerPath) return null;
  const dir = path.dirname(runnerPath);
  const base = path.basename(runnerPath, path.extname(runnerPath));
  const candidates = [
    path.join(dir, "sv_patch.manifest.json"),
    path.join(dir, `${base}.manifest.json`),
    path.join(dir, `${base}.manifest.json`.replaceAll(" ", "_")),
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {}
  }
  return null;
}

function loadManifest(manifestPath) {
  const obj = safeReadJson(manifestPath);

  if (!obj || typeof obj !== "object") throw new Error("Manifest inválido (objeto).");

  // ✅ Accept "toolset" manifest format: { tools: [ { entry, args, ... } ] }
  // If tools[] exists, unwrap tools[0] as the effective manifest for the current flow.
  let tool = obj;
  if (Array.isArray(obj.tools)) {
    if (!obj.tools.length) throw new Error("Manifest inválido: tools[] vazio.");
    tool = obj.tools[0];
    if (!tool || typeof tool !== "object") throw new Error("Manifest inválido: tools[0] inválido.");

    // Keep some toolset metadata attached (optional; doesn't change flow)
    tool._toolset = {
      toolset_id: obj.toolset_id || null,
      name: obj.name || null,
      version: obj.version || null,
    };
  }

  // minimal validation (host needs these)
  if (!tool.entry || typeof tool.entry !== "object") throw new Error("Manifest inválido (entry).");
  if (!tool.args || typeof tool.args !== "object") throw new Error("Manifest inválido (args).");

  // Required arg names for this host
  for (const k of ["root", "pipeline", "plan", "apply", "report"]) {
    if (!tool.args[k]) throw new Error(`Manifest inválido: args.${k} ausente`);
  }
  if (!tool.entry.windows && !tool.entry.unix) throw new Error("Manifest inválido: entry.windows/unix ausente");

  return tool;
}

function makeDefaultReportPath(projectPath, manifest) {
  const def = manifest?.outputs?.report_default || "sv-report.json";
  return path.join(projectPath, def);
}

function normalizeCmdTemplate(arr, runnerPath) {
  // replace {runner} token
  return arr.map((x) => String(x).replaceAll("{runner}", runnerPath));
}

function buildPatchCommand({ runnerPath, manifest, projectPath, pipelinePath, mode }) {
  const isWin = process.platform === "win32";
  const template = isWin ? manifest.entry.windows : manifest.entry.unix;
  if (!Array.isArray(template) || template.length === 0) throw new Error("Manifest entry template inválido.");

  const cmdParts = normalizeCmdTemplate(template, runnerPath);
  const cmd = cmdParts[0];
  const baseArgs = cmdParts.slice(1);

  const args = [...baseArgs];

  args.push(manifest.args.root, projectPath);
  args.push(manifest.args.pipeline, pipelinePath);

  if (mode === "apply") args.push(manifest.args.apply);
  else args.push(manifest.args.plan);

  const reportPath = makeDefaultReportPath(projectPath, manifest);
  args.push(manifest.args.report, reportPath);

  if (mode === "apply") {
    // optional knobs (only if manifest declares them)
    if (manifest.args.backup) args.push(manifest.args.backup);
    if (manifest.args.rollback) args.push(manifest.args.rollback);
  }

  return { cmd, args, reportPath };
}

function toProjectRel(projectPath, anyPath) {
  const raw = String(anyPath || "").trim();
  if (!raw) return "";

  try {
    const abs = path.isAbsolute(raw) ? raw : path.resolve(projectPath || process.cwd(), raw);
    if (projectPath) {
      const rel = path.relative(path.resolve(projectPath), abs);
      if (rel && !rel.startsWith("..")) return posixRel(rel);
    }
    return posixRel(raw);
  } catch {
    return posixRel(raw);
  }
}

function safeReadJsonIfExists(filePath) {
  try {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function collectPreviewChanges(report, projectPath) {
  const out = [];
  const seen = new Set();

  const push = (p, action) => {
    const rel = toProjectRel(projectPath, p);
    if (!rel || rel === ".") return;
    const act = String(action || "change");
    const key = `${rel}|${act}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: rel, action: act });
  };

  const collectArray = (arr, fallbackAction) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      if (typeof item === "string") {
        push(item, fallbackAction);
        continue;
      }
      if (!item || typeof item !== "object") continue;

      const p =
        item.path ||
        item.file ||
        item.file_path ||
        item.rel_path ||
        item.rel ||
        item.target ||
        item.output;

      const action = item.action || item.op || item.kind || item.type || fallbackAction || "change";
      if (typeof p === "string" && p.trim()) push(p, action);

      if (Array.isArray(item.files)) collectArray(item.files, action);
      if (Array.isArray(item.changes)) collectArray(item.changes, action);
    }
  };

  collectArray(report?.scans, "change");
  collectArray(report?.changes, "change");
  collectArray(report?.files, "change");
  collectArray(report?.modified, "modify");
  collectArray(report?.created, "create");
  collectArray(report?.deleted, "delete");
  collectArray(report?.summary?.files_changed, "change");

  return out;
}

const PREVIEW_MAX_FILES = 5000;
const PREVIEW_MAX_TEXT_CHARS = 180000;
const PREVIEW_MAX_FILE_BYTES = 700 * 1024;
const PREVIEW_SUMMARY_PARSE_MAX_CHARS = 2000000;

function normalizePreviewAction(action) {
  const a = String(action || "").toLowerCase();
  if (a.includes("create") || a.includes("add") || a.includes("new")) return "ADD";
  if (a.includes("delete") || a.includes("remove")) return "DEL";
  if (a.includes("modify") || a.includes("update") || a.includes("change") || a.includes("patch")) return "MOD";
  return "MOD";
}

function clipPreviewText(text, maxChars = PREVIEW_MAX_TEXT_CHARS) {
  const s = String(text || "");
  if (!s) return "";
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + "\n...(truncated)...";
}

function pickStringField(obj, names) {
  if (!obj || typeof obj !== "object") return "";
  for (const n of names) {
    const v = obj[n];
    if (typeof v === "string" && v.length) return v;
    if (v && typeof v === "object") {
      if (typeof v.text === "string" && v.text.length) return v.text;
      if (typeof v.content === "string" && v.content.length) return v.content;
      if (typeof v.value === "string" && v.value.length) return v.value;
      if (typeof v.body === "string" && v.body.length) return v.body;
    }
  }
  return "";
}

function looksLikePathToken(s) {
  const t = String(s || "").trim();
  if (!t) return false;
  if (t.includes("/") || t.includes("\\")) return true;
  if (/\.[a-z0-9]{1,10}$/i.test(t)) return true;
  return false;
}

function cleanPathCandidate(raw) {
  let s = String(raw || "").trim();
  if (!s) return "";
  s = s.replaceAll("`", "");
  s = s.replace(/^['"]+|['"]+$/g, "");
  s = s.replace(/^\s*(?:Root|Path|File)\s*:\s*/i, "");
  s = s.replace(/\s+\((?:NEW|ADD|MOD|DEL|CHANGE|CHG)\)\s*$/i, "");
  s = s.replace(/^a\//, "").replace(/^b\//, "");
  return s.trim();
}

function isLikelyFilePathCandidate(raw, projectPath) {
  const s = cleanPathCandidate(raw);
  if (!s) return false;
  if (s.length > 320) return false;
  if (/^(?:root|plan only|strict|backup|rollback|duration|status)\s*:/i.test(String(raw || "").trim())) return false;
  if (/^[a-z]+:\/\//i.test(s)) return false;
  if (/[<>`$;{}|]/.test(s)) return false;
  if (/[?#]/.test(s)) return false;
  if (/\b(?:const|let|var|function|return|if|for|while)\b/.test(s)) return false;
  if (!looksLikePathToken(s)) return false;

  const rel = toProjectRel(projectPath, s);
  if (!rel || rel === ".") return false;
  if (rel.startsWith("../")) return false;
  if (/^[a-z]:$/i.test(rel)) return false;
  if (/\s{2,}/.test(rel)) return false;
  if (/[()]/.test(rel) && !rel.includes("/")) return false;
  return true;
}

function readProjectTextIfExists(projectPath, relPath) {
  try {
    if (!projectPath || !relPath) return "";
    const abs = path.resolve(projectPath, relPath);
    if (!fs.existsSync(abs)) return "";
    const st = fs.statSync(abs);
    if (!st || !st.isFile()) return "";
    if (st.size > PREVIEW_MAX_FILE_BYTES) return "";
    return clipPreviewText(fs.readFileSync(abs, "utf-8"));
  } catch {
    return "";
  }
}

function collectPreviewDetails(report, projectPath) {
  const map = new Map();

  const put = (p, action, beforeText, afterText, diffText, opts = {}) => {
    const rel = toProjectRel(projectPath, p);
    if (!rel || rel === ".") return;
    const key = rel;
    const curr = map.get(key) || {
      path: rel,
      action: normalizePreviewAction(action),
      beforeText: "",
      afterText: "",
      diffText: "",
      hasBefore: false,
      hasAfter: false,
      beforeSource: "",
      afterSource: "",
    };

    if (action) curr.action = normalizePreviewAction(action);
    if (!curr.beforeText && beforeText) {
      curr.beforeText = clipPreviewText(beforeText);
      curr.hasBefore = true;
      curr.beforeSource = opts.beforeSource || "report";
    }
    if (!curr.afterText && afterText) {
      curr.afterText = clipPreviewText(afterText);
      curr.hasAfter = true;
      curr.afterSource = opts.afterSource || "report";
    }
    if (!curr.diffText && diffText) curr.diffText = clipPreviewText(diffText);
    map.set(key, curr);
  };

  const findPathCandidate = (obj) => {
    if (!obj || typeof obj !== "object") return "";

    const direct =
      obj.path ||
      obj.file ||
      obj.file_path ||
      obj.rel_path ||
      obj.rel ||
      obj.target ||
      obj.output ||
      obj.dst ||
      obj.dest ||
      obj.to ||
      obj.from;
    if (typeof direct === "string" && direct.trim()) return cleanPathCandidate(direct);

    for (const [k, v] of Object.entries(obj)) {
      const key = String(k || "").toLowerCase();
      if (!/(path|file|target|output|dest|dst|rel|to|from)/.test(key)) continue;
      if (typeof v === "string" && v.trim() && isLikelyFilePathCandidate(v, projectPath)) {
        return cleanPathCandidate(v);
      }
    }

    return "";
  };

  const findActionCandidate = (obj, fallbackAction) => {
    if (!obj || typeof obj !== "object") return fallbackAction || "change";
    return obj.action || obj.op || obj.kind || obj.type || obj.change_type || fallbackAction || "change";
  };

  const collectNode = (node, fallbackAction, depth, seen, allowStringPaths = false) => {
    if (depth > 16) return;
    if (node === null || node === undefined) return;

    if (typeof node === "string") {
      if (allowStringPaths && isLikelyFilePathCandidate(node, projectPath)) {
        put(cleanPathCandidate(node), fallbackAction, "", "", "");
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) collectNode(item, fallbackAction, depth + 1, seen, allowStringPaths);
      return;
    }

    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    const obj = node;
    const p = findPathCandidate(obj);
    const action = findActionCandidate(obj, fallbackAction);

    const beforeText = pickStringField(obj, [
      "beforeText",
      "before_text",
      "before",
      "oldText",
      "old_text",
      "old",
      "original",
      "previous",
      "prev",
      "source_text",
      "input_text",
    ]);
    const afterText = pickStringField(obj, [
      "afterText",
      "after_text",
      "after",
      "newText",
      "new_text",
      "new",
      "result",
      "updated",
      "output_text",
      "final_text",
    ]);
    const diffText = pickStringField(obj, [
      "diffText",
      "diff_text",
      "diff",
      "patch",
      "unified_diff",
      "unidiff",
      "changes_text",
    ]);

    if (typeof p === "string" && p.trim() && isLikelyFilePathCandidate(p, projectPath)) {
      put(cleanPathCandidate(p), action, beforeText, afterText, diffText);
    }

    for (const [k, v] of Object.entries(obj)) {
      const key = String(k || "").toLowerCase();
      const nextAllowStrings = /(files?|paths?|changes?|modified|created|deleted|outputs?|results?|hits)/.test(key);
      if (v && (typeof v === "object" || Array.isArray(v))) {
        collectNode(v, action, depth + 1, seen, nextAllowStrings);
      }
    }
  };

  const seen = new Set();
  collectNode(report?.steps, "change", 0, seen, false);
  collectNode(report?.scans, "change", 0, seen, false);
  collectNode(report?.changes, "change", 0, seen, true);
  collectNode(report?.files, "change", 0, seen, true);
  collectNode(report?.modified, "modify", 0, seen, true);
  collectNode(report?.created, "create", 0, seen, true);
  collectNode(report?.deleted, "delete", 0, seen, true);
  collectNode(report?.summary?.files_changed, "change", 0, seen, true);
  for (const [k, v] of Object.entries(report || {})) {
    const key = String(k || "").toLowerCase();
    if (!/(change|scan|file|result|output|patch|diff|write|apply|modified|created|deleted)/.test(key)) continue;
    collectNode(v, "change", 0, seen, /(files?|paths?|changes?)/.test(key));
  }

  return map;
}

function collectSummaryDiffsByPath(summaryText, projectPath) {
  const map = new Map();
  const raw = String(summaryText || "").replace(/\r\n/g, "\n");
  if (!raw) return map;

  const add = (p, diffText) => {
    if (!isLikelyFilePathCandidate(p, projectPath)) return;
    const rel = toProjectRel(projectPath, cleanPathCandidate(p));
    if (!rel || rel === "." || !diffText) return;
    if (!map.has(rel)) map.set(rel, clipPreviewText(diffText));
  };

  // unified diff sections: diff --git a/... b/...
  const blockRe = /(^|\n)(diff --git a\/([^\n]+) b\/([^\n]+)\n[\s\S]*?)(?=\ndiff --git a\/|\n*$)/g;
  let m;
  while ((m = blockRe.exec(raw))) {
    const pA = cleanPathCandidate(String(m[3] || "").trim());
    const pB = cleanPathCandidate(String(m[4] || "").trim());
    add(pB || pA, String(m[2] || "").trim());
  }

  // markdown fenced diff blocks tied to nearest path-like heading/list/path line
  const lines = raw.split("\n");
  let currentPath = "";
  let inDiffFence = false;
  let buff = [];

  for (const line of lines) {
    if (!inDiffFence) {
      let maybe = "";
      const h = line.match(/^#{1,6}\s+(.+)$/);
      if (h) maybe = h[1];
      const b = line.match(/^\s*[-*]\s+`?(.+?)`?\s*$/);
      if (!maybe && b) maybe = b[1];
      const p = line.match(/^\s*(?:file|path)\s*:\s*(.+?)\s*$/i);
      if (!maybe && p) maybe = p[1];

      if (maybe && isLikelyFilePathCandidate(maybe, projectPath)) {
        currentPath = cleanPathCandidate(maybe);
      }

      if (/^\s*```diff\s*$/i.test(line)) {
        inDiffFence = true;
        buff = [];
      }
      continue;
    }

    if (/^\s*```\s*$/.test(line)) {
      if (currentPath && buff.length) add(currentPath, buff.join("\n"));
      inDiffFence = false;
      buff = [];
      continue;
    }

    buff.push(line);
  }

  return map;
}

function collectSummaryFileHints(summaryText, projectPath) {
  const out = new Map();
  const raw = String(summaryText || "").replace(/\r\n/g, "\n");
  if (!raw) return out;

  const add = (p, action = "MOD") => {
    if (!isLikelyFilePathCandidate(p, projectPath)) return;
    const rel = toProjectRel(projectPath, cleanPathCandidate(p));
    if (!rel || rel === ".") return;
    if (!out.has(rel)) out.set(rel, normalizePreviewAction(action));
  };

  const lines = raw.split("\n");
  for (const line of lines) {
    const h = line.match(/^#{1,6}\s+(.+)$/);
    if (h) add(h[1]);

    const b = line.match(/^\s*[-*]\s+`?(.+?)`?\s*$/);
    if (b) add(b[1]);

    const p = line.match(/^\s*(?:file|path)\s*:\s*(.+?)\s*$/i);
    if (p) add(p[1]);

    const d1 = line.match(/^---\s+(?:a\/)?(.+)$/);
    if (d1) add(String(d1[1]).trim(), "DEL");
    const d2 = line.match(/^\+\+\+\s+(?:b\/)?(.+)$/);
    if (d2) add(String(d2[1]).trim(), "ADD");
  }

  return out;
}

function collectStepScriptFiles(report, projectPath) {
  const out = [];
  const steps = Array.isArray(report?.steps) ? report.steps : [];

  for (const step of steps) {
    const scripts = Array.isArray(step?.scripts) ? step.scripts : [];
    for (const script of scripts) {
      const files = Array.isArray(script?.files) ? script.files : [];
      for (const f of files) {
        const filePath = f?.file || f?.path || f?.rel_path || f?.target || "";
        if (!isLikelyFilePathCandidate(filePath, projectPath)) continue;

        const relPath = toProjectRel(projectPath, cleanPathCandidate(filePath));
        const ops = Array.isArray(f?.ops) ? f.ops : [];
        const changedByOps = ops.some((op) => Number(op?.changed || 0) > 0);
        const changed = Boolean(f?.changed) || changedByOps;
        const hasDiff = typeof f?.diff === "string" && f.diff.trim().length > 0;
        const isNew = Boolean(f?.is_new) || Number(f?.bytes_before || 0) === 0;
        if (!changed && !hasDiff && !isNew) continue;

        out.push({
          path: relPath,
          action: isNew ? "ADD" : "MOD",
          beforeText: "",
          afterText: "",
          diffText: hasDiff ? String(f.diff) : "",
          hasBefore: false,
          hasAfter: false,
          beforeSource: "",
          afterSource: "",
          changeEvidence: true,
        });
      }
    }
  }

  return out;
}

function buildPreviewFiles(report, projectPath, summaryText) {
  const changes = collectPreviewChanges(report, projectPath);
  const stepFiles = collectStepScriptFiles(report, projectPath);
  const detailsMap = collectPreviewDetails(report, projectPath);
  const summaryDiffMap = collectSummaryDiffsByPath(summaryText, projectPath);
  const summaryHints = collectSummaryFileHints(summaryText, projectPath);
  const outMap = new Map();

  const merge = (entry) => {
    if (!entry || !entry.path) return;
    const key = entry.path;
    const prev = outMap.get(key) || {
      path: key,
      action: "MOD",
      beforeText: "",
      afterText: "",
      diffText: "",
      hasBefore: false,
      hasAfter: false,
      beforeSource: "",
      afterSource: "",
      changeEvidence: false,
    };
    const nextAction = normalizePreviewAction(entry.action || prev.action);
    // Never downgrade ADD/DEL into MOD when other collectors bring generic "change".
    if (prev.action === "ADD" || prev.action === "DEL") {
      // keep strongest existing action
    } else if (nextAction === "ADD" || nextAction === "DEL") {
      prev.action = nextAction;
    } else {
      prev.action = nextAction;
    }
    if (!prev.beforeText && entry.beforeText) prev.beforeText = clipPreviewText(entry.beforeText);
    if (!prev.afterText && entry.afterText) prev.afterText = clipPreviewText(entry.afterText);
    if (!prev.diffText && entry.diffText) prev.diffText = clipPreviewText(entry.diffText);
    prev.hasBefore = Boolean(prev.hasBefore || entry.hasBefore || Boolean(entry.beforeText));
    prev.hasAfter = Boolean(prev.hasAfter || entry.hasAfter || Boolean(entry.afterText));
    if (!prev.beforeSource && entry.beforeSource) prev.beforeSource = String(entry.beforeSource);
    if (!prev.afterSource && entry.afterSource) prev.afterSource = String(entry.afterSource);
    prev.changeEvidence = Boolean(
      prev.changeEvidence ||
        entry.changeEvidence ||
        Boolean(entry.diffText) ||
        Boolean(entry.afterText) ||
        Boolean(entry.beforeText)
    );
    outMap.set(key, prev);
  };

  for (const sf of stepFiles) merge(sf);

  for (const c of changes) {
    merge({
      path: String(c.path || ""),
      action: c.action,
      beforeText: "",
      afterText: "",
      diffText: "",
    });
  }

  for (const d of detailsMap.values()) merge(d);

  for (const [p, diffText] of summaryDiffMap.entries()) {
    merge({ path: p, action: "MOD", diffText });
  }
  for (const [p, action] of summaryHints.entries()) {
    merge({ path: p, action });
  }

  const files = Array.from(outMap.values())
    .filter((f) => Boolean(f.changeEvidence || f.diffText || f.afterText || f.action === "ADD" || f.action === "DEL"))
    .sort((a, b) => a.path.localeCompare(b.path));

  // Disk fallback only where it is semantically safe (DEL or MOD with known after side).
  for (const f of files) {
    const canUseBeforeDisk =
      !f.beforeText && (f.action === "DEL" || (f.action === "MOD" && Boolean(f.afterText) && Boolean(f.hasAfter)));
    if (canUseBeforeDisk) {
      const before = readProjectTextIfExists(projectPath, f.path);
      if (before) {
        f.beforeText = before;
        if (!f.beforeSource) f.beforeSource = "disk";
      }
    }
  }

  // fallback: one-file report with no per-file diff -> attach summary text as textual diff
  if (files.length === 1 && !files[0].diffText && summaryText) {
    files[0].diffText = clipPreviewText(summaryText);
  }

  return files.slice(0, PREVIEW_MAX_FILES).map((f) => ({
    path: f.path,
    action: normalizePreviewAction(f.action),
    beforeText: f.beforeText || "",
    afterText: f.afterText || "",
    diffText: f.diffText || "",
    hasBefore: Boolean(f.hasBefore || f.beforeText),
    hasAfter: Boolean(f.hasAfter || f.afterText),
    beforeSource: f.beforeSource || "",
    afterSource: f.afterSource || "",
  }));
}

function readSummaryExcerpt(summaryPath) {
  try {
    if (!summaryPath) return "";
    if (!fs.existsSync(summaryPath)) return "";
    const raw = fs.readFileSync(summaryPath, "utf-8");
    const MAX_CHARS = 120000;
    if (raw.length <= MAX_CHARS) return raw;
    return raw.slice(0, MAX_CHARS) + "\n...(truncated)...";
  } catch {
    return "";
  }
}

function readSummaryForParse(summaryPath) {
  try {
    if (!summaryPath) return "";
    if (!fs.existsSync(summaryPath)) return "";
    const raw = fs.readFileSync(summaryPath, "utf-8");
    if (raw.length <= PREVIEW_SUMMARY_PARSE_MAX_CHARS) return raw;
    return raw.slice(0, PREVIEW_SUMMARY_PARSE_MAX_CHARS);
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────
// UI bootstrap
ipcMain.handle("ui:refresh", async () => {
  for (const entry of state.logs) {
    try {
      win?.webContents.send("log:append", `[${entry.ts}] [${entry.level}] ${entry.msg}`);
    } catch {}
  }
  push();
});

ipcMain.handle("ui:help", async () => {
  const msg = [
    "Project Manager & SV Patch",
    "",
    "Files:",
    "• Expand/collapse folders via caret",
    "• Ignore/unignore via eye icon",
    "• Exports respect ignored items",
    "",
    "Patch:",
    "• Pick runner (.py/.exe/.bat) and ensure a manifest exists next to it",
    "• Pick one or more .rw scripts (must be inside project root)",
    "• Pipeline is generated automatically and can be edited",
    "• Run Plan (dry-run) or Run Apply (writes changes)",
  ].join("\n");
  await dialog.showMessageBox(win, { type: "info", title: "Help", message: msg });
});

// ─────────────────────────────────────────────
// Project / Tree
ipcMain.handle("project:open", async () => {
  const folder = await pickProjectFolder();
  if (!folder) return;

  state.projectPath = folder;
  state.ignored.clear();
  state.patch.selectedRws = [];
  state.patch.rejectedRws = [];
  state.patch.lastPipelinePath = null;

  log("SYSTEM", `Opened: ${folder}`);
  push({ status: "Scanning…" });

  const { root, index } = core.scanProject(folder, log);
  state.tree = root;
  state.index = index;

  const st = core.computeStats(state);
  log("INFO", `Items: ${formatCount(st.items)} · Files: ${formatCount(st.files)} · Folders: ${formatCount(st.folders)}`);
  push({ status: "Ready." });

  // Auto-refresh watcher (keeps Files in sync with external changes)
  _startProjectWatcher(folder);
});


ipcMain.handle("project:refresh", async () => {
  if (!ensureProjectOpen()) return;

  const folder = state.projectPath;

  log("SYSTEM", `Refreshing: ${folder}`);
  push({ status: "Rescanning…" });

  // Re-scan project tree/index (source of truth)
  try {
    const { root, index } = core.scanProject(folder, log);
    state.tree = root;
    state.index = index;
  } catch (e) {
    log("ERROR", `Refresh scan failed: ${e.message || e}`);
    push({ status: "Ready." });
    return;
  }

  // Clean ignored items that no longer exist (prevents "ghost" ignored entries)
  try {
    const nextIgnored = new Set();
    for (const abs of state.ignored) {
      try {
        if (fs.existsSync(abs)) nextIgnored.add(abs);
      } catch {}
    }
    if (nextIgnored.size !== state.ignored.size) state.ignored = nextIgnored;
  } catch {}

  const st = core.computeStats(state);
  log("INFO", `Items: ${formatCount(st.items)} · Files: ${formatCount(st.files)} · Folders: ${formatCount(st.folders)}`);
  push({ status: "Ready." });
});

ipcMain.handle("tree:toggleIgnored", async (_, absPath) => {
  if (!ensureProjectOpen()) return;
  core.toggleIgnored(absPath, state, log);
  push();
});

ipcMain.handle("tree:clearIgnored", async () => {
  if (!ensureProjectOpen()) return;
  core.clearIgnored(state, log);
  push();
});

// ─────────────────────────────────────────────
// File View (read file content + meta)
ipcMain.handle("file:read", async (_, absPath) => {
  if (!ensureProjectOpen()) return { ok: false, error: "No project open." };

  try {
    const root = path.resolve(state.projectPath);
    const abs = path.resolve(String(absPath || ""));
    const rel = path.relative(root, abs);

    if (!rel || rel.startsWith("..")) {
      return { ok: false, error: "Path outside project root." };
    }

    const meta = state.index.get(abs) || null;
    if (meta?.isDir) return { ok: false, error: "Is a directory." };
    if (!fs.existsSync(abs)) return { ok: false, error: "File does not exist." };

    // hard cap to avoid UI freeze
    const MAX_BYTES = 1024 * 1024; // 1MB
    let sizeBytes = meta?.sizeBytes ?? 0;
    try {
      const st = fs.statSync(abs);
      sizeBytes = st.size;
    } catch {}

    if (sizeBytes > MAX_BYTES) {
      return {
        ok: false,
        error: `File too large for preview (${sizeBytes} bytes). Limit is ${MAX_BYTES} bytes.`,
        meta: {
          relPath: posixRel(rel),
          ext: meta?.ext || path.extname(abs) || "",
          sizeBytes,
          mtimeMs: meta?.mtimeMs || 0,
        },
      };
    }

    let content = "";
    try {
      content = fs.readFileSync(abs, "utf-8");
    } catch (e) {
      return {
        ok: false,
        error: `Could not read as text: ${e.message || e}`,
        meta: {
          relPath: posixRel(rel),
          ext: meta?.ext || path.extname(abs) || "",
          sizeBytes,
          mtimeMs: meta?.mtimeMs || 0,
        },
      };
    }

    return {
      ok: true,
      content,
      meta: {
        relPath: posixRel(rel),
        ext: meta?.ext || path.extname(abs) || "",
        sizeBytes,
        mtimeMs: meta?.mtimeMs || 0,
      },
    };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});


// ─────────────────────────────────────────────
// File Edit (write file content)
ipcMain.handle("file:write", async (_, absPath, content) => {
  if (!ensureProjectOpen()) return { ok: false, error: "No project open." };

  try {
    const root = path.resolve(state.projectPath);
    const abs = path.resolve(String(absPath || ""));
    const rel = path.relative(root, abs);

    if (!rel || rel.startsWith("..")) {
      return { ok: false, error: "Path outside project root." };
    }

    const meta = state.index.get(abs) || null;
    if (meta?.isDir) return { ok: false, error: "Is a directory." };
    if (!fs.existsSync(abs)) return { ok: false, error: "File does not exist." };

    const text = String(content ?? "");

    // hard cap to avoid huge writes from UI
    const MAX_BYTES = 1024 * 1024; // 1MB
    const byteLen = Buffer.byteLength(text, "utf8");
    if (byteLen > MAX_BYTES) {
      return { ok: false, error: `Content too large (${byteLen} bytes). Limit is ${MAX_BYTES} bytes.` };
    }

    fs.writeFileSync(abs, text, "utf-8");

    // refresh index meta for this file
    let sizeBytes = byteLen;
    let mtimeMs = Date.now();
    try {
      const st = fs.statSync(abs);
      sizeBytes = st.size;
      mtimeMs = st.mtimeMs;
    } catch {}

    const ext = meta?.ext || path.extname(abs) || "";
    state.index.set(abs, { isDir: false, ext, sizeBytes, mtimeMs });

    log("SUCCESS", `Saved: ${posixRel(rel)}`);
    push();
    return { ok: true, meta: { relPath: posixRel(rel), ext, sizeBytes, mtimeMs } };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});


// ─────────────────────────────────────────────
// Export
ipcMain.handle("export:json", async () => {
  if (!ensureProjectOpen()) return;
  const out = await saveAs("report.json", [{ name: "JSON", extensions: ["json"] }]);
  if (!out) return;

  try {
    const model = core.buildExportModel(state);
    await core.exportJson(out, model);
    log("SUCCESS", `Exported JSON: ${out}`);
  } catch (e) {
    log("ERROR", `Export JSON failed: ${e.message || e}`);
  }
});

ipcMain.handle("export:txt", async () => {
  if (!ensureProjectOpen()) return;
  const out = await saveAs("report.txt", [{ name: "Text", extensions: ["txt"] }]);
  if (!out) return;

  try {
    const model = core.buildExportModel(state);
    await core.exportTxt(out, model, state.projectPath, log);
    log("SUCCESS", `Exported TXT: ${out}`);
  } catch (e) {
    log("ERROR", `Export TXT failed: ${e.message || e}`);
  }
});


// ─────────────────────────────────────────────
// Preset file I/O (renderer-driven preset object; no export IPC changes)
ipcMain.handle("preset:saveAs", async (_, payload = {}) => {
  if (!ensureProjectOpen()) return { ok: false, error: "No project open" };
  try {
    const suggested = String(payload?.suggestedName || "preset.pmspreset.json").trim() || "preset.pmspreset.json";
    const defaultPath = path.join(state.projectPath || app.getPath("documents"), suggested);
    const res = await dialog.showSaveDialog(win, {
      title: "Save preset",
      defaultPath,
      filters: [
        { name: "Preset JSON", extensions: ["pmspreset.json", "json"] },
      ],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const outPath = String(res.filePath);
    await fs.promises.writeFile(outPath, String(payload?.presetJsonString || "{}"), "utf8");
    log("SUCCESS", `Preset saved: ${outPath}`);
    return { ok: true, path: outPath };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

ipcMain.handle("preset:open", async (_, payload = {}) => {
  if (!ensureProjectOpen()) return { ok: false, error: "No project open" };
  try {
    const defaultPath = String(payload?.projectRoot || state.projectPath || app.getPath("documents"));
    const res = await dialog.showOpenDialog(win, {
      title: "Import preset",
      defaultPath,
      properties: ["openFile"],
      filters: [
        { name: "Preset JSON", extensions: ["pmspreset.json", "json"] },
      ],
    });
    if (res.canceled || !res.filePaths?.[0]) return { canceled: true };
    const filePath = String(res.filePaths[0]);
    const contents = await fs.promises.readFile(filePath, "utf8");
    log("INFO", `Preset imported: ${filePath}`);
    return { ok: true, path: filePath, contents };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
});

// ─────────────────────────────────────────────
// Logs
ipcMain.handle("logs:copy", async () => {
  const text = state.logs.map((e) => `[${e.ts}] [${e.level}] ${e.msg}`).join("\n");
  clipboard.writeText(text);
  log("INFO", "Logs copied");
});

ipcMain.handle("logs:clear", async () => {
  state.logs = [];
  try {
    win?.webContents.send("log:reset");
  } catch {}
  log("INFO", "Logs cleared");
});

// ─────────────────────────────────────────────
// Runner & Manifest
ipcMain.handle("patch:pickRunner", async () => {
  const res = await dialog.showOpenDialog(win, {
    title: "Select patch runner",
    properties: ["openFile"],
    filters: [
      { name: "Runner", extensions: ["py", "exe", "bat", "cmd", "sh"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (res.canceled || !res.filePaths?.[0]) return null;

  const runnerPath = res.filePaths[0];
  state.patch.runnerPath = runnerPath;

  const manifestPath = findManifestForRunner(runnerPath);
  state.patch.manifestPath = manifestPath;

  if (!manifestPath) {
    state.patch.manifest = null;
    log(
      "WARNING",
      "Manifest not found next to runner. Expected sv_patch.manifest.json (recommended) or <runner>.manifest.json"
    );
  } else {
    try {
      const m = loadManifest(manifestPath);
      state.patch.manifest = m;
      log("SUCCESS", `Loaded manifest: ${manifestPath}`);
    } catch (e) {
      state.patch.manifest = null;
      log("ERROR", `Failed to load manifest: ${e.message || e}`);
    }
  }

  const settings = readSettings();
  settings.runner_path = runnerPath;
  settings.manifest_path = manifestPath || null;
  writeSettings(settings);

  push();
  return { runnerPath, manifestPath, manifest: state.patch.manifest };
});

ipcMain.handle("patch:reloadManifest", async () => {
  if (!state.patch.runnerPath) {
    log("INFO", "No runner selected.");
    return null;
  }
  const manifestPath = findManifestForRunner(state.patch.runnerPath);
  state.patch.manifestPath = manifestPath;

  if (!manifestPath) {
    state.patch.manifest = null;
    log("WARNING", "Manifest not found next to runner.");
    push();
    return null;
  }

  try {
    state.patch.manifest = loadManifest(manifestPath);
    log("SUCCESS", `Reloaded manifest: ${manifestPath}`);
  } catch (e) {
    state.patch.manifest = null;
    log("ERROR", `Failed to load manifest: ${e.message || e}`);
  }

  const settings = readSettings();
  settings.manifest_path = manifestPath;
  writeSettings(settings);

  push();
  return { manifestPath, manifest: state.patch.manifest };
});

// ─────────────────────────────────────────────
// Patch: select .rw
ipcMain.handle("patch:pickRw", async () => {
  if (!ensureProjectOpen()) return { valid: [], rejected: [] };

  const res = await dialog.showOpenDialog(win, {
    title: "Select .rw script(s)",
    filters: [{ name: "RW scripts", extensions: ["rw"] }],
    properties: ["openFile", "multiSelections"],
  });

  if (res.canceled) return { valid: [], rejected: [] };

  const root = path.resolve(state.projectPath);
  const valid = [];
  const rejected = [];

  for (const abs of res.filePaths || []) {
    const absNorm = path.resolve(abs);
    const rel = path.relative(root, absNorm);

    if (!rel || rel.startsWith("..")) {
      rejected.push(absNorm);
      continue;
    }
    valid.push(posixRel(rel));
  }

  state.patch.selectedRws = valid;
  state.patch.rejectedRws = rejected;
  push();

  return { valid, rejected };
});

// Patch: generate pipeline (1 step per rw)
ipcMain.handle("patch:generatePipeline", async (_, rwList) => {
  if (!ensureProjectOpen()) return null;

  const list = Array.isArray(rwList) ? rwList.filter(Boolean).map(posixRel) : [];
  if (!list.length) return null;

  const steps = list.map((rw, i) => ({
    name: `rw-${String(i + 1).padStart(2, "0")}`,
    scripts: [rw],
  }));

  return {
    version: 1,
    generated_by: "Project Manager & SV Patch",
    steps,
  };
});

// Patch: save pipeline (editable JSON)
ipcMain.handle("patch:savePipeline", async (_, payload) => {
  if (!ensureProjectOpen()) return null;

  const text = String(payload?.pipelineText ?? "").trim();
  if (!text) throw new Error("Pipeline vazio.");

  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("Pipeline JSON inválido.");
  }

  if (!obj || !Array.isArray(obj.steps) || obj.steps.length === 0) {
    throw new Error("Pipeline precisa ter steps[].");
  }
  for (const s of obj.steps) {
    if (!s || !Array.isArray(s.scripts) || s.scripts.length === 0) {
      throw new Error("Cada step precisa ter scripts[] não vazio.");
    }
  }

  const pipelinesDir = path.join(state.projectPath, "data", "pipelines");
  fs.mkdirSync(pipelinesDir, { recursive: true });

  const outPath = path.join(pipelinesDir, "generated.pipeline.json");
  fs.writeFileSync(outPath, JSON.stringify(obj, null, 2), "utf-8");

  state.patch.lastPipelinePath = outPath;
  log("SUCCESS", `Pipeline saved: ${outPath}`);
  push();

  return outPath;
});

// Patch: preview apply (runs plan + summarizes report before confirm)
ipcMain.handle("patch:previewApply", async (_, payload) => {
  if (!ensureProjectOpen()) return { ok: false, error: "No project open." };

  if (patchProc) {
    log("WARNING", "A patch process is already running. Stop it before preview.");
    return { ok: false, error: "Patch already running." };
  }

  const pipelinePath = String(payload?.pipelinePath || "").trim();
  if (!pipelinePath) {
    log("ERROR", "Pipeline path vazio (salve o pipeline antes).");
    return { ok: false, error: "Pipeline path vazio." };
  }
  if (!fs.existsSync(pipelinePath)) {
    log("ERROR", `Pipeline does not exist: ${pipelinePath}`);
    return { ok: false, error: "Pipeline does not exist." };
  }

  if (!state.patch.runnerPath) {
    log("ERROR", "Runner is not selected. Use 'Pick runner'.");
    return { ok: false, error: "Runner not selected." };
  }
  if (!fs.existsSync(state.patch.runnerPath)) {
    log("ERROR", `Runner does not exist: ${state.patch.runnerPath}`);
    return { ok: false, error: "Runner does not exist." };
  }
  if (!state.patch.manifest) {
    log("ERROR", "Manifest is not loaded. Put sv_patch.manifest.json next to runner and click 'Reload'.");
    return { ok: false, error: "Manifest not loaded." };
  }

  let cmd, args, reportPath;
  try {
    ({ cmd, args, reportPath } = buildPatchCommand({
      runnerPath: state.patch.runnerPath,
      manifest: state.patch.manifest,
      projectPath: state.projectPath,
      pipelinePath,
      mode: "plan",
    }));
  } catch (e) {
    const err = e?.message || String(e);
    log("ERROR", `Failed to build preview command: ${err}`);
    return { ok: false, error: err };
  }

  log(
    "SYSTEM",
    `Apply preview (plan): ${cmd} ${args.map((a) => (String(a).includes(" ") ? `"${a}"` : a)).join(" ")}`
  );
  log("INFO", `Preview report: ${reportPath}`);
  push({ status: "Previewing apply changes..." });

  const runRes = await new Promise((resolve) => {
    let spawnFailed = false;

    try {
      patchProc = spawn(cmd, args, {
        cwd: state.projectPath,
        windowsHide: true,
        shell: false,
      });
    } catch (e) {
      spawnFailed = true;
      const err = e?.message || String(e);
      patchProc = null;
      resolve({ exitCode: -1, spawnError: err });
    }

    if (spawnFailed || !patchProc) return;

    patchProc.stdout.on("data", (buf) => {
      for (const line of splitLinesChunked(buf.toString("utf-8"))) {
        if (line.length) log("PATCH", `[PREVIEW] ${line}`);
      }
    });
    patchProc.stderr.on("data", (buf) => {
      for (const line of splitLinesChunked(buf.toString("utf-8"))) {
        if (line.length) log("PATCH_ERR", `[PREVIEW] ${line}`);
      }
    });

    patchProc.on("close", (code, signal) => {
      patchProc = null;
      const normalizedCode = Number.isInteger(code) ? Number(code) : -1;
      resolve({ exitCode: normalizedCode, signal: signal || "" });
    });

    patchProc.on("error", (err) => {
      patchProc = null;
      resolve({ exitCode: -1, spawnError: err?.message || String(err) });
    });
  });

  if (runRes.spawnError) {
    log("ERROR", `Falha no preview: ${runRes.spawnError}`);
    push({ status: "Ready." });
    return { ok: false, error: runRes.spawnError };
  }

  log("SYSTEM", `Preview finished (code=${runRes.exitCode})`);

  const report = safeReadJsonIfExists(reportPath);
  const errors = Array.isArray(report?.errors) ? report.errors : [];
  const rejects = Array.isArray(report?.rejects) ? report.rejects : [];

  const summaryPathRaw = report?.summary_path ? String(report.summary_path) : "";
  const summaryPath = summaryPathRaw ? path.resolve(summaryPathRaw) : "";
  const summaryExcerpt = readSummaryExcerpt(summaryPath);
  const summaryForParse = readSummaryForParse(summaryPath);
  const files = buildPreviewFiles(report, state.projectPath, summaryForParse || summaryExcerpt);
  const changes = files.map((f) => ({ path: f.path, action: f.action }));

  const ok = runRes.exitCode === 0 && !runRes.signal && errors.length === 0;
  if (!ok) {
    log(
      "WARNING",
      `Preview indicates risk (exit=${runRes.exitCode}, signal=${runRes.signal || "-"}, errors=${errors.length}, rejects=${rejects.length}).`
    );
  } else {
    log("SUCCESS", `Preview ready: ${files.length} potential change(s).`);
  }

  push({ status: "Ready." });

  return {
    ok,
    exitCode: runRes.exitCode,
    signal: runRes.signal || "",
    reportPath,
    summaryPath: summaryPath || null,
    summaryExcerpt,
    durationMs: Number(report?.duration_ms || 0),
    errorsCount: errors.length,
    rejectsCount: rejects.length,
    changesCount: files.length,
    changes: changes.slice(0, 200),
    files,
    error: !ok ? (errors[0]?.error || errors[0]?.message || "Preview returned issues.") : "",
  };
});

// Patch: run pipeline (plan/apply) using manifest
ipcMain.handle("patch:runPipeline", async (_, payload) => {
  if (!ensureProjectOpen()) return { ok: false, error: "project_not_open" };

  if (patchProc) {
    log("WARNING", "Já existe um patch rodando. Pare antes de iniciar outro.");
    return;
  }

  const mode = payload?.mode === "apply" ? "apply" : "plan";
  const pipelinePath = String(payload?.pipelinePath || "").trim();
  if (!pipelinePath) {
    log("ERROR", "Pipeline path vazio (salve o pipeline antes).");
    return;
  }
  if (!fs.existsSync(pipelinePath)) {
    log("ERROR", `Pipeline não existe: ${pipelinePath}`);
    return;
  }

  if (!state.patch.runnerPath) {
    log("ERROR", "Runner não selecionado. Use 'Pick runner'.");
    return;
  }
  if (!fs.existsSync(state.patch.runnerPath)) {
    log("ERROR", `Runner não existe: ${state.patch.runnerPath}`);
    return;
  }
  if (!state.patch.manifest) {
    log("ERROR", "Manifest não carregado. Coloque sv_patch.manifest.json ao lado do runner e clique 'Reload'.");
    return;
  }

  let cmd, args, reportPath;
  try {
    ({ cmd, args, reportPath } = buildPatchCommand({
      runnerPath: state.patch.runnerPath,
      manifest: state.patch.manifest,
      projectPath: state.projectPath,
      pipelinePath,
      mode,
    }));
  } catch (e) {
    log("ERROR", `Failed to build command: ${e.message || e}`);
    return;
  }

  log(
    "SYSTEM",
    `Patch start (${mode}): ${cmd} ${args.map((a) => (String(a).includes(" ") ? `"${a}"` : a)).join(" ")}`
  );
  log("INFO", `Report: ${reportPath}`);
  push({ status: `Patch running (${mode})…` });

  patchProc = spawn(cmd, args, {
    cwd: state.projectPath,
    windowsHide: true,
    shell: false,
  });

  patchProc.stdout.on("data", (buf) => {
    for (const line of splitLinesChunked(buf.toString("utf-8"))) {
      if (line.length) log("PATCH", line);
    }
  });
  patchProc.stderr.on("data", (buf) => {
    for (const line of splitLinesChunked(buf.toString("utf-8"))) {
      if (line.length) log("PATCH_ERR", line);
    }
  });

  patchProc.on("close", (code) => {
    log("SYSTEM", `Patch finished (code=${code})`);
    patchProc = null;

    // Re-scan after run
    try {
      push({ status: "Rescanning…" });
      const { root, index } = core.scanProject(state.projectPath, log);
      state.tree = root;
      state.index = index;
    } catch (e) {
      log("WARNING", `Re-scan falhou: ${e.message || e}`);
    }

    push({ status: "Ready." });
  });

  patchProc.on("error", (err) => {
    log("ERROR", `Falha ao iniciar patch: ${err.message || err}`);
    patchProc = null;
    push({ status: "Ready." });
  });
});

// Patch: stop
ipcMain.handle("patch:stop", async () => {
  if (!patchProc) {
    log("INFO", "Nenhum patch rodando.");
    return;
  }
  log("WARNING", "Parando patch…");
  try {
    patchProc.kill("SIGTERM");
  } catch (e) {
    log("ERROR", `Falha ao parar patch: ${e.message || e}`);
  }
});

// ─────────────────────────────────────────────
async function createWindow() {
  // Restore saved runner/manifest
  const settings = readSettings();
  if (settings.runner_path && fs.existsSync(settings.runner_path)) {
    state.patch.runnerPath = settings.runner_path;

    const mp = findManifestForRunner(settings.runner_path) || settings.manifest_path;
    if (mp && fs.existsSync(mp)) {
      state.patch.manifestPath = mp;
      try {
        state.patch.manifest = loadManifest(mp);
      } catch (e) {
        state.patch.manifest = null;
        log("WARNING", `Saved manifest load failed: ${e.message || e}`);
      }
    }
  }

  win = new BrowserWindow({
    width: 1400,
    height: 900,
    backgroundColor: COLORS.bg,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile(path.join(__dirname, "ui.html"));
  win.on("closed", () => {
    win = null;
  });
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
