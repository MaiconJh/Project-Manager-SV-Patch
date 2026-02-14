const fs = require('fs');

const ui = fs.readFileSync('src/ui.js', 'utf8');
const html = fs.readFileSync('src/ui.html', 'utf8');

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
}

if (!/function\s+bind\s*\(/.test(ui)) fail('bind() missing');
if (!/function\s+_bindClickSafe\s*\(/.test(ui)) fail('_bindClickSafe missing');

const requiredIds = [
  'btnOpen',
  'btnRefreshFiles',
  'btnExportPrimary',
  'btnPresetMenu',
  'presetMenuSave',
  'presetMenuImport',
];
for (const id of requiredIds) {
  if (!html.includes(`id="${id}"`)) fail(`missing html id: ${id}`);
}

for (const id of ['btnOpen', 'btnRefreshFiles', 'btnExportPrimary']) {
  if (!ui.includes(`_bindClickSafe("${id}"`)) fail(`${id} not bound via _bindClickSafe`);
}

const forbidden = [
  'el("btnOpen")?.addEventListener("click"',
  'el("btnRefreshFiles")?.addEventListener("click"',
  'el("btnExportPrimary")?.addEventListener("click"',
  'el("btnPresetMenu")?.addEventListener("click"',
];
for (const pat of forbidden) {
  if (ui.includes(pat)) fail(`forbidden direct click binding found: ${pat}`);
}

if (!ui.includes('console.info(`[UI] bind complete:')) fail('bind health info log missing');
if (!ui.includes('console.error("[UI] Missing element:", id)')) fail('missing-element error log missing');
if (!ui.includes('console.error("[UI] Handler failed:", id, e)')) fail('handler-failed error log missing');
if (!ui.includes('window.addEventListener("error"')) fail('window error trap missing');
if (!ui.includes('window.addEventListener("unhandledrejection"')) fail('window unhandledrejection trap missing');

console.log('PASS ui global buttons integrity validation');
