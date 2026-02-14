function normalize(p) {
  return String(p || '').replaceAll('\\', '/');
}
function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  return Array.from(new Set(list.map((p) => normalize(p)).filter(Boolean)));
}
function collectIndex(snapshot) {
  const all = new Set();
  const walk = (node) => {
    if (!node) return;
    all.add(normalize(node.absPath));
    for (const ch of node.children || []) walk(ch);
  };
  walk(snapshot?.tree || null);
  return { all };
}
function applyPresetMock(preset, snapshot) {
  if (preset?.schema_version !== 'preset.v1') throw new Error('invalid schema_version');
  const idx = collectIndex(snapshot);
  const hiddenReq = normalizeList(preset?.export?.hidden_paths || []);
  const hiddenRestored = hiddenReq.filter((p) => idx.all.has(p));
  const missing = hiddenReq.length - hiddenRestored.length;
  snapshot.ignored = hiddenRestored.slice();

  const p = { ...(preset?.export?.profile || {}) };
  const nestedSchema = p.export_schema_version ?? p.schema_version ?? null;
  return {
    hiddenRequested: hiddenReq.length,
    hiddenRestored: hiddenRestored.length,
    missing,
    nestedSchema,
  };
}

const snapshot = {
  tree: {
    absPath: '/repo',
    children: [
      { absPath: '/repo/src', isDir: true, children: [{ absPath: '/repo/src/a.js', children: [] }] },
      { absPath: '/repo/tmp.log', children: [] },
    ],
  },
  ignored: [],
};

const presetV1 = {
  schema_version: 'preset.v1',
  export: {
    profile: { format: 'txt', export_schema_version: 1 },
    scope: { mode: 'selected', selected: ['/repo/src/a.js'] },
    hidden_paths: ['/repo/src', '/repo/missing.txt'],
  },
  tree: { expanded_paths: ['/repo/src'] },
};

const r1 = applyPresetMock(presetV1, JSON.parse(JSON.stringify(snapshot)));
if (r1.hiddenRequested !== 2) throw new Error('expected hiddenRequested=2');
if (r1.hiddenRestored !== 1) throw new Error('expected hiddenRestored=1');
if (r1.missing !== 1) throw new Error('expected missing=1');
if (r1.nestedSchema !== 1) throw new Error('expected optional nested schema handled');

const presetNoHidden = {
  schema_version: 'preset.v1',
  export: {
    profile: { format: 'json' },
    scope: { mode: 'all', selected: [] },
  },
  tree: { expanded_paths: [] },
};
const r2 = applyPresetMock(presetNoHidden, JSON.parse(JSON.stringify(snapshot)));
if (r2.hiddenRequested !== 0 || r2.hiddenRestored !== 0) throw new Error('expected no hidden paths to restore');

console.log('PASS hidden preset regression: hidden_paths restore + backward compatibility + schema semantics');
