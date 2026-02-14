const assert = require('assert');

function n(p){ return String(p||'').replaceAll('\\','/'); }
function validatePresetV1(presetObj, projectRoot){
  if (!presetObj || typeof presetObj !== 'object') return {ok:false,error:'Preset JSON must be an object'};
  if (presetObj.schema_version !== 'preset.v1') return {ok:false,error:'Invalid schema_version (expected preset.v1)'};
  if (String(presetObj.project_root||'') !== String(projectRoot||'')) return {ok:false,error:'Preset belongs to another project', mismatch:true};
  if (!presetObj.export || typeof presetObj.export !== 'object') return {ok:false,error:'Missing export section'};
  return {ok:true};
}
function collectIndex(snapshot){
  const all=new Set(), dirs=new Set();
  const walk=(x)=>{ if(!x) return; const a=n(x.absPath); if(a){all.add(a); if(x.isDir) dirs.add(a);} for(const c of x.children||[]) walk(c); };
  walk(snapshot.tree); return {all,dirs};
}
function classify(snapshot, reqSel){
  const idx=collectIndex(snapshot); let resolved=0, missing=0;
  for(const p0 of reqSel||[]){ const p=n(p0); if(!p) continue; if(idx.all.has(p)) resolved++; else missing++; }
  if (resolved===0 && (reqSel||[]).length>0) return {status:'BROKEN',missing};
  if (missing>0) return {status:'PARTIAL',missing};
  return {status:'OK',missing:0};
}

const snapshot={ projectPath:'/p', tree:{isDir:true,absPath:'/p',children:[
  {isDir:true,absPath:'/p/dir',children:[{isDir:false,absPath:'/p/dir/a.txt',children:[]}]},
  {isDir:false,absPath:'/p/root.txt',children:[]}
]}};

const valid={
  schema_version:'preset.v1',
  created_at:new Date().toISOString(),
  project_root:'/p',
  export:{ profile:{ format:'json', content_level:'full', include_tree:true, include_hashes:false, include_ignored_summary:true, sort_mode:'alpha' }, scope:{ mode:'selected', selected:['/p/dir','/p/root.txt'] } },
  tree:{ expanded_paths:['/p/dir'] }
};
const invalidSchema={...valid, schema_version:'preset.v0'};
const mismatch={...valid, project_root:'/other'};
const partial={...valid, export:{...valid.export, scope:{mode:'selected', selected:['/p/dir','/p/missing.txt']}}};

assert.strictEqual(validatePresetV1(valid, snapshot.projectPath).ok, true);
assert.strictEqual(validatePresetV1(invalidSchema, snapshot.projectPath).ok, false);
assert.strictEqual(validatePresetV1(mismatch, snapshot.projectPath).ok, false);
assert.strictEqual(validatePresetV1(mismatch, snapshot.projectPath).mismatch, true);
assert.strictEqual(classify(snapshot, partial.export.scope.selected).status, 'PARTIAL');

console.log('PASS valid preset schema');
console.log('PASS invalid schema_version rejected');
console.log('PASS project_root mismatch rejected');
console.log('PASS partial missing paths classified PARTIAL');
