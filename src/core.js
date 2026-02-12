const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
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

function buildExportModel(state) {
  if (!state.projectPath) throw new Error("Nenhum projeto carregado.");

  const model = {
    project_path: state.projectPath,
    generated_at: new Date().toISOString().replace("T"," ").slice(0,19),
    ignored: [],
    files: [],
  };

  for (const p of state.ignored) {
    model.ignored.push(safeRel(state.projectPath, p));
  }
  model.ignored.sort((a,b)=>a.localeCompare(b));

  for (const [p, m] of state.index.entries()) {
    if (m.isDir) continue;
    if (state.ignored.has(p)) continue;
    if (DEFAULT_IGNORE_EXTS.has(m.ext)) continue;

    model.files.push({
      path: safeRel(state.projectPath, p),
      ext: m.ext,
      size_bytes: m.sizeBytes,
      mtime_ms: m.mtimeMs,
    });
  }
  model.files.sort((a,b)=>a.path.localeCompare(b.path));
  return model;
}

async function exportJson(outPath, model) {
  await fsp.writeFile(outPath, JSON.stringify(model, null, 2), "utf-8");
}

async function exportTxt(outPath, model, projectPath, log) {
  const lines = [];
  lines.push("PROJECT REPORT");
  lines.push("=".repeat(72));
  lines.push(`Project: ${projectPath}`);
  lines.push(`Generated: ${model.generated_at}`);
  lines.push("");

  if (model.ignored.length) {
    lines.push("Ignored:");
    for (const ig of model.ignored) lines.push(`- ${ig}`);
    lines.push("");
  }

  for (const file of model.files) {
    const abs = path.join(projectPath, file.path);
    lines.push("-".repeat(72));
    lines.push(`File: ${file.path}`);
    lines.push(`Ext: ${file.ext}`);
    lines.push("");
    try {
      const content = await fsp.readFile(abs, "utf-8");
      lines.push(content);
    } catch (e) {
      lines.push(`[Could not read: ${e.message || e}]`);
      if (log) log("WARNING", `Não foi possível ler: ${abs}`);
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
  exportJson,
  exportTxt,
};
