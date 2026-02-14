const fs = require('fs');

const ui = fs.readFileSync('src/ui.js', 'utf8');
const html = fs.readFileSync('src/ui.html', 'utf8');

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
}

if (!/function\s+bind\s*\(/.test(ui)) fail('bind() missing');
if (!/function\s+_bindClickSafe\s*\(/.test(ui)) fail('_bindClickSafe missing');
if (!/Promise\.resolve\(\)\s*\.\s*then\(/s.test(ui) || !/\.catch\(\(e\)\s*=>/s.test(ui)) {
  fail('_bindClickSafe does not enforce async rejection handling');
}

const requiredIds = [
  'btnOpen',
  'btnRefreshFiles',
  'btnExportPrimary',
  'btnPresetMenu',
  'presetMenuSave',
  'presetMenuImport',
];

for (const id of requiredIds) {
  const hits = [...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length;
  if (hits !== 1) fail(`required id must exist exactly once: ${id} (found ${hits})`);
}

for (const id of requiredIds) {
  if (!ui.includes(`_bindClickSafe("${id}"`)) fail(`${id} not bound via _bindClickSafe`);
}

const directClickPatterns = [
  /el\("btnOpen"\)\??\.addEventListener\("click"/,
  /el\("btnRefreshFiles"\)\??\.addEventListener\("click"/,
  /el\("btnExportPrimary"\)\??\.addEventListener\("click"/,
  /el\("btnPresetMenu"\)\??\.addEventListener\("click"/,
  /el\("presetMenuSave"\)\??\.addEventListener\("click"/,
  /el\("presetMenuImport"\)\??\.addEventListener\("click"/,
];
for (const pat of directClickPatterns) {
  if (pat.test(ui)) fail(`forbidden direct click binding found: ${pat}`);
}

if (!ui.includes('console.info("[UI] bind complete:",')) fail('bind health info log missing');
if (!ui.includes('console.error("[UI] Missing element:", id)')) fail('missing-element error log missing');
if (!ui.includes('console.error("[UI] Handler failed:", id, e)')) fail('handler-failed error log missing');
if (!ui.includes('window.addEventListener("error"')) fail('window error trap missing');
if (!ui.includes('window.addEventListener("unhandledrejection"')) fail('window unhandledrejection trap missing');

if (!ui.includes('function _uiHitTestAtCenter(')) fail('hit-test helper missing');
if (!ui.includes('function _runUiGlobalHitTestReport(')) fail('hit-test report helper missing');
if (!ui.includes('PM_UI_DIAG_HITTEST')) fail('PM_UI_DIAG_HITTEST gating missing');

console.log('PASS ui global buttons integrity validation');
