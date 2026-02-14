const fs = require('fs');
const vm = require('vm');

const src = fs.readFileSync('src/ui.js', 'utf8');

function extractFunction(name) {
  const sig = `function ${name}(`;
  const start = src.indexOf(sig);
  if (start < 0) throw new Error(`Missing ${name}`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`Unclosed function ${name}`);
}

const sandbox = { Set, console };
vm.createContext(sandbox);
vm.runInContext(`${extractFunction('_normalizeAbsPath')}\n${extractFunction('_collectSnapshotPathIndex')}`, sandbox);

const preset = {
  schema_version: 'preset.v1',
  export: {
    scope: {
      mode: 'selected',
      selected: ['/proj/src', '/proj/src/a.js'],
    },
  },
  tree: {
    expanded_paths: ['/proj/src'],
  },
};

const snapshot = {
  projectPath: '/proj',
  tree: {
    absPath: '/proj',
    isDir: true,
    children: [
      {
        absPath: '/proj/src',
        isDir: true,
        children: [
          { absPath: '/proj/src/a.js', isDir: false, children: [] },
        ],
      },
    ],
  },
};

const idx = sandbox._collectSnapshotPathIndex(snapshot);
if (!(idx.all instanceof Set)) throw new Error('idx.all is not Set');
if (!(idx.dirs instanceof Set)) throw new Error('idx.dirs is not Set');
if (!idx.dirs.has('/proj/src')) throw new Error('idx.dirs.has failed for folder path');
if (!idx.all.has('/proj/src/a.js')) throw new Error('idx.all.has failed for file path');

const selectedSet = new Set();
for (const p0 of preset.export.scope.selected || []) {
  const p = sandbox._normalizeAbsPath(p0);
  if (!p || !idx.all.has(p)) continue;
  selectedSet.add(p);
}
if (!(selectedSet instanceof Set)) throw new Error('selectedSet not initialized as Set');
if (selectedSet.size <= 0) throw new Error('selectedSet expected to contain imported selected paths');

console.log('PASS preset apply regression: idx.dirs/idx.all Set guards prevent .has crash');
