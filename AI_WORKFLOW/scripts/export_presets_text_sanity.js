const fs=require('fs');
const src=fs.readFileSync('src/ui.js','utf8');
const html=fs.readFileSync('src/ui.html','utf8');
const checks=[];
const pass=(name,ok,msg='')=>checks.push(`${ok?'PASS':'FAIL'} ${name}${msg?` :: ${msg}`:''}`);

pass('save file button exists in HTML', html.includes('id="btnPresetSaveFile"'));
pass('import file button exists in HTML', html.includes('id="btnPresetImportFile"'));
pass('preset.v1 builder exists', /function\s+_buildPresetV1\s*\(/.test(src));
pass('preset.v1 validator exists', /function\s+_validatePresetV1\s*\(/.test(src));
pass('saveAs IPC is used', src.includes('ipcRenderer.invoke("preset:saveAs"'));
pass('open IPC is used', src.includes('ipcRenderer.invoke("preset:open"'));
pass('apply health feedback exists', src.includes('Applied preset:'));

console.log(checks.join('\n'));
if (checks.some((x)=>x.startsWith('FAIL'))) process.exit(1);
