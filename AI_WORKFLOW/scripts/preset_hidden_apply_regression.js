const path = require('path');

function normalizeAbsPath(p) {
  return String(p || '').replaceAll('\\\\', '/');
}
function normalizePathList(list, projectRoot = '') {
  if (!Array.isArray(list)) return [];
  const root = normalizeAbsPath(projectRoot || '');
  const out = [];
  for (const raw of list) {
    let p = String(raw || '').trim();
    if (!p) continue;
    p = normalizeAbsPath(p);
    if (root && !path.isAbsolute(p)) p = normalizeAbsPath(path.join(root, p));
    out.push(p);
  }
  return Array.from(new Set(out));
}
function collectSnapshotPathIndex(snapshot) {
  const all = new Set();
  const dirs = new Set();
  const actualByNorm = new Map();
  const walk = (node) => {
    if (!node) return;
    const actual = String(node.absPath || '');
    const norm = normalizeAbsPath(actual);
    all.add(norm);
    if (!actualByNorm.has(norm)) actualByNorm.set(norm, actual);
    if (node.isDir || Array.isArray(node.children)) dirs.add(norm);
    for (const ch of node.children || []) walk(ch);
  };
  walk(snapshot?.tree || null);
  return { all, dirs, actualByNorm };
}

function simulateHiddenApply(preset, snapshot) {
  const order = [];
  const idx = collectSnapshotPathIndex(snapshot);
  const requestedHidden = normalizePathList(preset?.export?.hidden_paths || [], snapshot?.projectPath || '');
  const hiddenToRestore = [];
  for (const hp of requestedHidden) {
    if (!hp || !idx.all.has(hp)) continue;
    hiddenToRestore.push(idx.actualByNorm.get(hp) || hp);
  }
  order.push('clear');
  for (const hp of hiddenToRestore) order.push(`toggle:${hp}`);
  order.push('render');
  const missing = requestedHidden.length - hiddenToRestore.length;
  const status = missing > 0 ? (hiddenToRestore.length > 0 ? 'PARTIAL' : 'BROKEN') : 'OK';
  return { order, hiddenToRestore, requestedHidden, missing, status };
}

const snapshot = {
  projectPath: '/repo',
  tree: {
    absPath: '/repo',
    isDir: true,
    children: [
      { absPath: '/repo/src', isDir: true, children: [{ absPath: '/repo/src/a.js', isDir: false, children: [] }] },
      { absPath: '/repo/docs/readme.md', isDir: false, children: [] },
    ],
  },
};

const preset = {
  schema_version: 'preset.v1',
  export: { hidden_paths: ['src', '/repo/docs/readme.md', '/repo/missing.txt'] },
};

const r1 = simulateHiddenApply(preset, snapshot);
if (!path.isAbsolute(path.normalize(r1.hiddenToRestore[0] || '/repo/src'))) throw new Error('normalized hidden path should be absolute/native capable');
if (r1.order[0] !== 'clear' || r1.order[r1.order.length - 1] !== 'render') throw new Error('ordering must be clear -> toggles -> render');
if (r1.status !== 'PARTIAL' || r1.missing !== 1) throw new Error('partial classification expected with one missing hidden path');

const r2 = simulateHiddenApply(preset, snapshot);
if (JSON.stringify(r1.hiddenToRestore) !== JSON.stringify(r2.hiddenToRestore)) throw new Error('deterministic replay failed (toggle inversion risk)');

console.log('PASS preset hidden apply regression: normalization, ordering, determinism, PARTIAL classification');
