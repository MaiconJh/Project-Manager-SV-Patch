const fs = require('fs');

const html = fs.readFileSync('src/ui.html', 'utf8');
const ui = fs.readFileSync('src/ui.js', 'utf8');
const css = fs.readFileSync('src/ui.css', 'utf8');

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
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
  const count = [...html.matchAll(new RegExp(`id="${id}"`, 'g'))].length;
  if (count !== 1) fail(`id ${id} expected once, found ${count}`);
}

if (!/function\s+_bindClickSafe\s*\(/.test(ui)) fail('_bindClickSafe missing');
if (!/Promise\.resolve\(\)\s*\.\s*then\(/s.test(ui)) fail('Promise.resolve().then wrapper missing in _bindClickSafe');
if (!/\.catch\(\(e\)\s*=>/s.test(ui)) fail('Promise.catch wrapper missing in _bindClickSafe');

if (!ui.includes('window.addEventListener("error"')) fail('window error hook missing');
if (!ui.includes('window.addEventListener("unhandledrejection"')) fail('window unhandledrejection hook missing');

const forbiddenPointerNone = [
  /\.panel\.files\s+\.panelHead[^\{]*\{[^\}]*pointer-events\s*:\s*none/si,
  /\.panel\.files\s+\.panelHeadTools[^\{]*\{[^\}]*pointer-events\s*:\s*none/si,
  /\.presetQuick[^\{]*\{[^\}]*pointer-events\s*:\s*none/si,
  /\.presetMenuBtn[^\{]*\{[^\}]*pointer-events\s*:\s*none/si,
];
for (const pat of forbiddenPointerNone) {
  if (pat.test(css)) fail(`forbidden pointer-events:none rule detected: ${pat}`);
}

if (!/\.panel\.files\s+\.panelHeadTools[^\{]*\{[^\}]*pointer-events\s*:\s*auto/si.test(css)) {
  fail('missing explicit pointer-events:auto for files header action row (.panel.files .panelHeadTools)');
}

console.log('PASS ui global buttons runtime risks validation');
