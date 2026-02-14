const fs=require('fs');
const src=fs.readFileSync('src/ui.js','utf8');
const checks=[];
const pass=(name,ok,msg='')=>checks.push(`${ok?'PASS':'FAIL'} ${name}${msg?` :: ${msg}`:''}`);

pass('localStorage key exists', src.includes('pm_sv_export_presets_v1'));
pass('load presets function exists', /function\s+_loadExportPresetsConfig\s*\(/.test(src));
pass('save presets function exists', /function\s+_saveExportPresetsConfig\s*\(/.test(src));
pass('save action triggers dropdown refresh', /function\s+_savePresetByName[\s\S]*?_refreshPresetControlsUi\(\)/.test(src));
pass('apply action has explicit failure feedback', src.includes('Apply failed: choose a preset') && src.includes('Apply failed: selected preset not found'));
pass('health evaluator exists', /function\s+_evaluatePresetHealth\s*\(/.test(src));
pass('auto-apply token guard exists', src.includes('lastAppliedCycleToken') && src.includes('refreshCycleToken'));

console.log(checks.join('\n'));
if (checks.some((x)=>x.startsWith('FAIL'))) process.exit(1);
