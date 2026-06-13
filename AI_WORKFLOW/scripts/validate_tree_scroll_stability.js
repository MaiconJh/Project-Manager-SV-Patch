const fs = require('fs');

const ui = fs.readFileSync('src/ui.js', 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(/function\s+_getTreeScrollContainer\s*\(/.test(ui), 'missing _getTreeScrollContainer');
assert(/function\s+_captureTreeScrollState\s*\(/.test(ui), 'missing _captureTreeScrollState');
assert(/function\s+_restoreTreeScrollState\s*\(/.test(ui), 'missing _restoreTreeScrollState');
assert(/function\s+_withPreservedTreeScroll\s*\(/.test(ui), 'missing _withPreservedTreeScroll');

assert(ui.includes('_withPreservedTreeScroll(() => {'), 'render path not wrapped with _withPreservedTreeScroll');
assert(ui.includes('requestAnimationFrame(() => _restoreTreeScrollState(captured));'), 'missing deferred restore');

const badPatterns = [
  'fileList")?.scrollTop = 0',
  'fileList.scrollTop = 0',
  'fileList.scrollTo(0, 0)',
];
for (const pat of badPatterns) {
  assert(!ui.includes(pat), `forbidden tree scroll reset pattern found: ${pat}`);
}

console.log('PASS tree scroll stability validation: helpers + render wrapper + no forced top reset');
