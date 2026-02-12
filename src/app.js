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

// Patch: run pipeline (plan/apply) using manifest
ipcMain.handle("patch:runPipeline", async (_, payload) => {
  if (!ensureProjectOpen()) return;

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
