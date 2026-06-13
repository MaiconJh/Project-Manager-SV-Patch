const fs = require('fs');

const html = fs.readFileSync('src/ui.html', 'utf8');
const ui = fs.readFileSync('src/ui.js', 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const requiredIds = ['btnPresetMenu', 'presetMenu', 'presetMenuSave', 'presetMenuImport'];
for (const id of requiredIds) {
  assert(html.includes(`id="${id}"`), `missing id in ui.html: ${id}`);
}

const btnBlock = html.slice(html.indexOf('id="btnPresetMenu"') - 200, html.indexOf('id="btnPresetMenu"') + 600);
assert((btnBlock.match(/<svg/g) || []).length >= 2, 'btnPresetMenu should include icon + chevron svg');

const saveBlock = html.slice(html.indexOf('id="presetMenuSave"') - 150, html.indexOf('id="presetMenuSave"') + 300);
const importBlock = html.slice(html.indexOf('id="presetMenuImport"') - 150, html.indexOf('id="presetMenuImport"') + 300);
assert(saveBlock.includes('<svg'), 'presetMenuSave must include inline svg');
assert(importBlock.includes('<svg'), 'presetMenuImport must include inline svg');

assert(/function\s+_bindPresetMenuUi\s*\(/.test(ui), 'missing _bindPresetMenuUi in ui.js');
assert(ui.includes('_bindPresetMenuUi();'), 'preset menu not bound during bind()');
assert(ui.includes('el("btnPresetSaveFile")?.click()'), 'menu save does not map to existing save path');
assert(ui.includes('el("btnPresetImportFile")?.click()'), 'menu import does not map to existing import path');
assert(ui.includes('document.addEventListener("click"'), 'outside click close logic missing');
assert(ui.includes('ev.key === "Escape"'), 'ESC close logic missing');

console.log('PASS preset menu validation: IDs, SVGs, bindings, and action mapping');
