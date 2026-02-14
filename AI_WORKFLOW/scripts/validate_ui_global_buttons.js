const fs = require('fs');

const html = fs.readFileSync('src/ui.html', 'utf8');
const uiJs = fs.readFileSync('src/ui.js', 'utf8');
const appJs = fs.readFileSync('src/app.js', 'utf8');

const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const elIdMatches = [...uiJs.matchAll(/el\("([^"]+)"\)/g)].map((m) => m[1]);
const buttonIds = new Set(elIdMatches.filter((id) => /^btn[A-Z]/.test(id)));

const REQUIRED_GLOBAL = [
  'btnOpen',
  'btnHelp',
  'btnRefreshFiles',
  'btnPresetSaveFile',
  'btnPresetImportFile',
  'btnExportPrimary',
  'btnCopyLogs',
  'btnClearLogs',
];

const missingIds = [];
for (const id of new Set([...REQUIRED_GLOBAL, ...buttonIds])) {
  if (!htmlIds.has(id)) missingIds.push(id);
}

const missingBindings = [];
for (const id of buttonIds) {
  const direct = new RegExp(`el\\("${id}"\\)\\??\\.addEventListener\\(`).test(uiJs);
  const safe = new RegExp(`_bindClickSafe\\("${id}"`).test(uiJs);
  if (!direct && !safe) missingBindings.push(id);
}

const uiChannels = [...uiJs.matchAll(/ipcRenderer\.(?:invoke|send)\("([^"]+)"/g)].map((m) => m[1]);
const uniqueChannels = [...new Set(uiChannels)];
const appHandles = new Set([...appJs.matchAll(/ipcMain\.(?:handle|on)\("([^"]+)"/g)].map((m) => m[1]));
const missingIpc = uniqueChannels.filter((ch) => !appHandles.has(ch));

const silentGuards = [...uiJs.matchAll(/if\s*\(![^\)]*\)\s*return\s*;?/g)].map((m) => m[0]);

const referencedPrivate = new Set();
for (const m of uiJs.matchAll(/\b(_[A-Za-z0-9_]+)\s*\(/g)) {
  const name = m[1];
  const prev = uiJs[m.index - 1] || '';
  if (prev === '.') continue;
  if (['if', 'for', 'while', 'switch', 'catch', 'function'].includes(name)) continue;
  referencedPrivate.add(name);
}
const definedPrivate = new Set();
for (const m of uiJs.matchAll(/function\s+(_[A-Za-z0-9_]+)\s*\(/g)) definedPrivate.add(m[1]);
for (const m of uiJs.matchAll(/const\s+(_[A-Za-z0-9_]+)\s*=\s*\(/g)) definedPrivate.add(m[1]);
for (const m of uiJs.matchAll(/const\s+(_[A-Za-z0-9_]+)\s*=\s*async\s*\(/g)) definedPrivate.add(m[1]);

const knownGlobalAllowed = new Set(['_']);
const missingPrivateRefs = [...referencedPrivate].filter((name) => !definedPrivate.has(name) && !knownGlobalAllowed.has(name));

console.log('== UI Global Buttons Integrity ==');
console.log(`Buttons discovered in ui.js: ${buttonIds.size}`);
console.log(`Missing IDs in ui.html: ${missingIds.length}`);
if (missingIds.length) console.log('  - ' + missingIds.join(', '));

console.log(`Missing event bindings in ui.js: ${missingBindings.length}`);
if (missingBindings.length) console.log('  - ' + missingBindings.join(', '));

console.log(`Missing IPC handlers in app.js: ${missingIpc.length}`);
if (missingIpc.length) console.log('  - ' + missingIpc.join(', '));

const guardSample = silentGuards.slice(0, 5);
console.log(`Suspicious silent guard returns found: ${silentGuards.length}`);
if (guardSample.length) {
  console.log('  sample:');
  for (const g of guardSample) console.log('   * ' + g);
}

console.log(`Missing private function references in ui.js: ${missingPrivateRefs.length}`);
if (missingPrivateRefs.length) {
  console.log('  - ' + missingPrivateRefs.join(', '));
}

if (!definedPrivate.has('_refreshPresetControlsUi')) {
  console.log('  - required private function missing: _refreshPresetControlsUi');
  process.exit(1);
}

if (missingIds.length || missingBindings.length || missingIpc.length || missingPrivateRefs.length) {
  process.exit(1);
}
console.log('PASS UI wiring integrity');
