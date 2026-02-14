const fs = require('fs');

const ui = fs.readFileSync('src/ui.js', 'utf8');
const app = fs.readFileSync('src/app.js', 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(/function\s+_applyHiddenPathsFromPreset\s*\(/.test(ui), 'missing _applyHiddenPathsFromPreset');
assert(/function\s+_awaitStateUpdateOnce\s*\(/.test(ui), 'missing _awaitStateUpdateOnce');

const hasClear = ui.includes('ipcRenderer.invoke("tree:clearIgnored")');
const hasToggle = ui.includes('ipcRenderer.invoke("tree:toggleIgnored"');
const hasWait = ui.includes('await _awaitStateUpdateOnce(1500)');
assert(hasClear, 'missing clearIgnored IPC call');
assert(hasToggle, 'missing toggleIgnored IPC call');
assert(hasWait, 'missing state:update wait after hidden apply');

const helperIdx = ui.indexOf('async function _applyHiddenPathsFromPreset');
const clearIdx = ui.indexOf('ipcRenderer.invoke("tree:clearIgnored")', helperIdx);
const toggleIdx = ui.indexOf('ipcRenderer.invoke("tree:toggleIgnored"', helperIdx);
const waitIdx = ui.indexOf('await _awaitStateUpdateOnce(1500)', helperIdx);
assert(helperIdx >= 0 && clearIdx > helperIdx, 'ordering invalid: helper/clear');
assert(toggleIdx > clearIdx, 'ordering invalid: toggle must follow clear');
assert(waitIdx > toggleIdx, 'ordering invalid: wait must follow toggles');

assert(/ipcMain\.handle\("tree:clearIgnored"/.test(app), 'app.js missing tree:clearIgnored handler');
assert(/ipcMain\.handle\("tree:toggleIgnored"/.test(app), 'app.js missing tree:toggleIgnored handler');

console.log('PASS preset hidden apply runtime contract: helper+channels+clear->toggle->wait ordering');
