const fs = require('fs');

const html = fs.readFileSync('src/ui.html', 'utf8');
const css = fs.readFileSync('src/ui.css', 'utf8');
const ui = fs.readFileSync('src/ui.js', 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(html.includes('id="filesBreadcrumb"'), 'missing #filesBreadcrumb in ui.html');
assert(/\.panel\.files\s+\.panelHead\s*\{[\s\S]*position\s*:\s*sticky/i.test(css), 'missing sticky rule scoped to Files header');

assert(/function\s+_updateFilesBreadcrumb\s*\(/.test(ui), 'missing breadcrumb updater in ui.js');
assert(/function\s+_setupKeyboardFocusModality\s*\(/.test(ui), 'missing keyboard modality setup in ui.js');
assert(ui.includes('document.body.classList.add("kbNav")'), 'missing kbNav add logic');
assert(ui.includes('document.body.classList.remove("kbNav")'), 'missing kbNav remove logic');


console.log('PASS files header breadcrumb validation: html/css/js integration checks');
