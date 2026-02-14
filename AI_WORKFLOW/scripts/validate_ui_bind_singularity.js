const fs = require('fs');

const ui = fs.readFileSync('src/ui.js', 'utf8');

function fail(msg) {
  console.error('FAIL', msg);
  process.exit(1);
}

const bindDefs = [...ui.matchAll(/^function\s+bind\s*\(/gm)].length;
if (bindDefs !== 1) fail(`expected exactly one bind() definition, found ${bindDefs}`);

if (!/function\s+_bindClickSafe\s*\(/.test(ui)) fail('_bindClickSafe missing');
if (!/Promise\.resolve\(\)\s*\.\s*then\(/s.test(ui) || !/\.catch\(\(e\)\s*=>/s.test(ui)) {
  fail('_bindClickSafe missing Promise rejection-safe wrapper');
}

if (!ui.includes('window.addEventListener("error", (e) => {')) fail('fatal error trap missing');
if (!ui.includes('window.addEventListener("unhandledrejection", (e) => {')) fail('fatal unhandledrejection trap missing');
if (!ui.includes('window.__uiBindRan')) fail('duplicate bind guard missing (window.__uiBindRan)');

const globalIds = [
  'btnOpen',
  'btnRefreshFiles',
  'btnExportPrimary',
  'btnPresetMenu',
  'presetMenuSave',
  'presetMenuImport',
  'btnExportTxt',
  'btnExportJson',
];

for (const id of globalIds) {
  if (!ui.includes(`_bindClickSafe("${id}"`)) fail(`${id} missing _bindClickSafe binding`);
}

const forbidden = [
  /el\("btnOpen"\)\??\.addEventListener\("click"/,
  /el\("btnRefreshFiles"\)\??\.addEventListener\("click"/,
  /el\("btnExportPrimary"\)\??\.addEventListener\("click"/,
  /el\("btnPresetMenu"\)\??\.addEventListener\("click"/,
  /el\("presetMenuSave"\)\??\.addEventListener\("click"/,
  /el\("presetMenuImport"\)\??\.addEventListener\("click"/,
  /el\("btnExportTxt"\)\??\.addEventListener\("click"/,
  /el\("btnExportJson"\)\??\.addEventListener\("click"/,
];
for (const pat of forbidden) {
  if (pat.test(ui)) fail(`forbidden direct global click binding found: ${pat}`);
}

if (!ui.includes('DOMContentLoaded')) fail('bind() not wired through DOMContentLoaded bootstrap');

console.log('PASS ui bind singularity validation');
