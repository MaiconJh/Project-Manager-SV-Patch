const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { TextDecoder } = require("util");
const { DEFAULT_IGNORE_EXTS, DEFAULT_IGNORE_DIRS, safeRel } = require("./config");

function makeId() {
  // stable enough for a session; based on time+rand
  return "n" + Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function shouldSkipDir(name) {
  return DEFAULT_IGNORE_DIRS.has(name);
}

function scanProject(rootDir, log) {
  // Returns: { root, index }
  // root: node tree {id,name,absPath,relPath,isDir,children}
  // index: Map absPath -> {isDir, ext, sizeBytes, mtimeMs}
  const index = new Map();

  const root = {
    id: makeId(),
    name: path.basename(rootDir),
    absPath: rootDir,
    relPath: ".",
    isDir: true,
    children: [],
  };

  const stack = [{ abs: rootDir, node: root }];

  while (stack.length) {
    const { abs, node } = stack.pop();

    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      log("WARNING", `Erro ao listar: ${abs} (${e.message || e})`);
      continue;
    }

    const dirs = entries
      .filter(e => e.isDirectory() && !shouldSkipDir(e.name))
      .sort((a,b)=>a.name.localeCompare(b.name));
    const files = entries
      .filter(e => e.isFile())
      .sort((a,b)=>a.name.localeCompare(b.name));

    for (const d of dirs) {
      const childAbs = path.join(abs, d.name);
      const rel = safeRel(rootDir, childAbs) || d.name;

      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(childAbs).mtimeMs; } catch {}
      index.set(childAbs, { isDir: true, ext: "", sizeBytes: 0, mtimeMs });

      const child = { id: makeId(), name: d.name, absPath: childAbs, relPath: rel, isDir: true, children: [] };
      node.children.push(child);
      stack.push({ abs: childAbs, node: child });
    }

    for (const f of files) {
      const childAbs = path.join(abs, f.name);
      const rel = safeRel(rootDir, childAbs) || f.name;

      let sizeBytes = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(childAbs);
        sizeBytes = st.size;
        mtimeMs = st.mtimeMs;
      } catch (e) {
        log("WARNING", `Erro ao stat: ${childAbs} (${e.message || e})`);
      }

      const ext = path.extname(f.name) || "";
      index.set(childAbs, { isDir: false, ext, sizeBytes, mtimeMs });

      const child = { id: makeId(), name: f.name, absPath: childAbs, relPath: rel, isDir: false, children: [] };
      node.children.push(child);
    }
  }

  return { root, index };
}

function toggleIgnored(absPath, state, log) {
  // If folder: toggle recursively for all paths under it (including itself if present in index)
  const inIndex = state.index.has(absPath);
  const meta = inIndex ? state.index.get(absPath) : null;

  const setTo = !state.ignored.has(absPath);

  if (meta && meta.isDir) {
    // mark/unmark everything with prefix
    for (const [p, m] of state.index.entries()) {
      if (p === absPath || p.startsWith(absPath + path.sep)) {
        if (setTo) state.ignored.add(p);
        else state.ignored.delete(p);
      }
    }
  } else {
    if (setTo) state.ignored.add(absPath);
    else state.ignored.delete(absPath);
  }

  log("INFO", `${setTo ? "Ignorado" : "Reativado"}: ${absPath}`);
}

function clearIgnored(state, log) {
  state.ignored.clear();
  log("INFO", "Ignorados limpos");
}

function computeStats(state) {
  let files = 0, folders = 0, ignoredFiles = 0, ignoredFolders = 0;

  for (const [p, m] of state.index.entries()) {
    if (m.isDir) folders++;
    else files++;

    if (state.ignored.has(p)) {
      if (m.isDir) ignoredFolders++;
      else ignoredFiles++;
    }
  }

  const selectedFiles = Math.max(0, files - ignoredFiles);

  return {
    files, folders,
    ignoredFiles, ignoredFolders,
    selectedFiles,
    items: state.index.size,
  };
}

function _normalizePath(p) {
  return String(p || "").replaceAll("\\", "/");
}

function _isPathWithinFolder(filePath, folderPath) {
  const fp = _normalizePath(filePath);
  const base = _normalizePath(folderPath);
  if (!fp || !base) return false;
  return fp === base || fp.startsWith(base.endsWith("/") ? base : (base + "/"));
}

function _loadExportSelectionConfig(state) {
  try {
    const cfgPath = path.join(state.projectPath, ".pm_sv_export_selection.json");
    if (!fs.existsSync(cfgPath)) return { selectedOnly: false, selectedSet: new Set(), profile: _normalizeExportProfile(null) };
    const raw = fs.readFileSync(cfgPath, "utf-8");
    const obj = JSON.parse(raw || "{}");
    const selectedOnly = Boolean(obj?.selectedOnly || String(obj?.selectedMode || "").toLowerCase() === "selected");
    const selected = Array.isArray(obj?.selected) ? obj.selected : [];
    const profile = _normalizeExportProfile(obj?.profile || {
      format: obj?.format,
      scope: selectedOnly ? "selected" : "all",
      content_level: obj?.contentLevel,
      include_tree: obj?.options?.treeHeader,
      include_hashes: obj?.options?.hashes,
      include_ignored_summary: obj?.options?.ignoredSummary,
      sort_mode: obj?.options?.sortDet === false ? "alpha" : "dir_first_alpha",
    });
    return { selectedOnly, selectedSet: new Set(selected.map(String)), profile };
  } catch {
    return { selectedOnly: false, selectedSet: new Set(), profile: _normalizeExportProfile(null) };
  }
}

function _resolveSelectedFiles(state, selectedSet) {
  const out = new Set();
  const selected = Array.from(selectedSet || []);
  if (!selected.length) return out;

  for (const [p, m] of state.index.entries()) {
    if (!m || m.isDir) continue;
    for (const sel of selected) {
      if (_isPathWithinFolder(p, sel)) {
        out.add(p);
        break;
      }
    }
  }

  return out;
}

function _sha256Hex(text) {
  try {
    return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
  } catch {
    return null;
  }
}

function _safeDecodeUtf8(absPath) {
  try {
    const buf = fs.readFileSync(absPath);
    if (!buf || !Buffer.isBuffer(buf)) {
      return { encoding: null, line_count: null, sha256: null, content: null, content_error: "binary_or_decode_failed" };
    }
    // quick binary hint
    for (let i = 0; i < Math.min(buf.length, 4096); i++) {
      if (buf[i] === 0) {
        return { encoding: null, line_count: null, sha256: null, content: null, content_error: "binary_or_decode_failed" };
      }
    }
    const dec = new TextDecoder("utf-8", { fatal: true });
    const content = dec.decode(buf);
    const line_count = content.length ? content.split(/\r?\n/).length : 0;
    const sha256 = _sha256Hex(content);
    return { encoding: "utf-8", line_count, sha256, content, content_error: null };
  } catch {
    return { encoding: null, line_count: null, sha256: null, content: null, content_error: "binary_or_decode_failed" };
  }
}

function _treeAddFile(root, relPath, fileIndex) {
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

function _sortTree(node, sortMode = "dir_first_alpha") {
  if (!node || !Array.isArray(node.children)) return;
  for (const ch of node.children) _sortTree(ch, sortMode);
  node.children.sort((a, b) => {
    if (sortMode === "dir_first_alpha") {
      const ta = a.type === "dir" ? 0 : 1;
      const tb = b.type === "dir" ? 0 : 1;
      if (ta !== tb) return ta - tb;
    }
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

const DEFAULT_EXPORT_PROFILE = {
  profile_id: "default",
  format: "txt",
  scope: "all",
  content_level: "standard",
  include_tree: true,
  include_hashes: false,
  include_ignored_summary: true,
  sort_mode: "dir_first_alpha",
  schema_version: 1,
};

function _normalizeExportProfile(profile) {
  const p = { ...(DEFAULT_EXPORT_PROFILE || {}), ...(profile || {}) };
  p.profile_id = String(p.profile_id || "default");
  p.format = p.format === "json" ? "json" : "txt";
  p.scope = p.scope === "selected" ? "selected" : "all";
  p.content_level = ["compact", "standard", "full"].includes(p.content_level) ? p.content_level : "standard";
  p.include_tree = Boolean(p.include_tree);
  p.include_hashes = Boolean(p.include_hashes);
  p.include_ignored_summary = Boolean(p.include_ignored_summary);
  p.sort_mode = p.sort_mode === "alpha" ? "alpha" : "dir_first_alpha";
  p.schema_version = 1;
  return p;
}

function buildUnifiedProjectReport(projectRootAbs, legacyModel, selectionState = {}, options = {}) {
  const files = Array.isArray(legacyModel?.files) ? legacyModel.files : [];
  const ignored = Array.isArray(legacyModel?.ignored) ? legacyModel.ignored.slice() : [];
  const profile = _normalizeExportProfile(selectionState.profile || null);
  const mode = profile.scope === "selected" ? "selected" : "all";
  const selectedCount = Number(selectionState.selected_count || 0);

  const tree = { type: "dir", name: ".", path: "", children: [] };
  const byPath = {};
  for (let i = 0; i < files.length; i++) {
    const rel = String(files[i].path || "").replaceAll("\\", "/");
    _treeAddFile(tree, rel, i);
    byPath[rel] = i;
  }
  _sortTree(tree, profile.sort_mode);

  return {
    // canonical
    schema_version: 1,
    report_type: "project_report",
    project: {
      path: projectRootAbs,
      generated_at: new Date().toISOString(),
      generator: "Project Manager & SV Patch",
      app_version: options.app_version ?? null,
    },
    export: {
      mode,
      profile,
      selected_count: selectedCount,
      exported_files_count: files.length,
      filters: {
        ignored_exts: Array.from(DEFAULT_IGNORE_EXTS).sort((a, b) => String(a).localeCompare(String(b))),
        ignored_paths: ignored.slice().sort((a, b) => String(a).localeCompare(String(b))),
      },
    },
    tree,
    files,
    index: {
      by_path: byPath,
    },

    // compatibility (legacy keys kept)
    project_path: legacyModel?.project_path || projectRootAbs,
    generated_at: legacyModel?.generated_at || new Date().toISOString().replace("T", " ").slice(0, 19),
    ignored,
  };
}

function buildExportModel(state, opts = null) {
  if (!state.projectPath) throw new Error("Nenhum projeto carregado.");

  const cfg = _loadExportSelectionConfig(state);
  const incomingProfile = opts?.exportProfile || null;
  const profile = _normalizeExportProfile(incomingProfile || cfg.profile || null);
  const selectedOnly = profile.scope === "selected";
  const selectedSet = opts?.selectedSet instanceof Set
    ? opts.selectedSet
    : (cfg.selectedSet instanceof Set ? cfg.selectedSet : new Set());
  const resolvedSelectedFiles = selectedOnly ? _resolveSelectedFiles(state, selectedSet) : null;
  const selectedCount = selectedOnly ? selectedSet.size : 0;

  const legacyModel = {
    project_path: state.projectPath,
    generated_at: new Date().toISOString().replace("T"," ").slice(0,19),
    ignored: [],
    files: [],
  };

  for (const p of state.ignored) {
    legacyModel.ignored.push(safeRel(state.projectPath, p));
  }
  legacyModel.ignored.sort((a,b)=>a.localeCompare(b));

  for (const [p, m] of state.index.entries()) {
    if (m.isDir) continue;
    if (selectedOnly && !resolvedSelectedFiles.has(p)) continue;
    if (state.ignored.has(p)) continue;
    if (DEFAULT_IGNORE_EXTS.has(m.ext)) continue;

    const relPath = String(safeRel(state.projectPath, p) || "").replaceAll("\\", "/");
    const decoded = _safeDecodeUtf8(p);
    const includeContent = profile.content_level !== "compact";
    const includeHashes = Boolean(profile.include_hashes);

    legacyModel.files.push({
      path: relPath,
      ext: m.ext,
      size_bytes: m.sizeBytes,
      mtime_ms: Number.isFinite(Number(m.mtimeMs)) ? Number(m.mtimeMs) : null,
      encoding: includeContent ? decoded.encoding : null,
      line_count: includeContent ? decoded.line_count : null,
      sha256: includeHashes ? decoded.sha256 : null,
      content: includeContent ? decoded.content : null,
      content_error: includeContent ? decoded.content_error : null,
    });
  }
  legacyModel.files.sort((a,b)=>a.path.localeCompare(b.path));
  return buildUnifiedProjectReport(
    state.projectPath,
    legacyModel,
    { selectedOnly, selected_count: selectedCount, profile },
    { app_version: null }
  );
}

async function exportJson(outPath, model) {
  await fsp.writeFile(outPath, JSON.stringify(model, null, 2), "utf-8");
}

async function exportTxt(outPath, model, projectPath, log) {
  const report = model || {};
  const lines = [];
  lines.push("PROJECT REPORT");
  lines.push("=".repeat(72));
  lines.push(`Project: ${report.project?.path || projectPath}`);
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
    if (typeof file.content === "string") {
      lines.push(file.content);
    } else {
      lines.push(`[Could not read: ${file.content_error || "binary_or_decode_failed"}]`);
      if (log) log("WARNING", `Não foi possível ler: ${file.path}`);
    }
    lines.push("");
  }

  // Importante: mantém o formato original (LF) como estava antes
  await fsp.writeFile(outPath, lines.join("\n"), "utf-8");
}

module.exports = {
  scanProject,
  toggleIgnored,
  clearIgnored,
  computeStats,
  buildExportModel,
  buildUnifiedProjectReport,
  exportJson,
  exportTxt,
};
