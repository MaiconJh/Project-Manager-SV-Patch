const assert = require('assert');

function n(p){ return String(p||'').replaceAll('\\','/'); }
function collectIndex(snapshot){
  const all=new Set(), dirs=new Set(), files=new Set();
  const walk=(x)=>{ if(!x) return; const a=n(x.absPath); if(a){all.add(a); if(x.isDir) dirs.add(a); else files.add(a);} for(const c of x.children||[]) walk(c);};
  walk(snapshot.tree); return {all,dirs,files};
}
function collectDesc(snapshot, folder){
  let tgt=null; const out=[];
  const find=(x)=>{ if(!x||tgt) return; if(n(x.absPath)===folder){tgt=x; return;} for(const c of x.children||[]) find(c);};
  const walk=(x)=>{ for(const c of x.children||[]){ out.push(n(c.absPath)); walk(c);} };
  find(snapshot.tree); if(tgt) walk(tgt); return out;
}
function evaluateHealth(preset,snapshot){
  const idx=collectIndex(snapshot);
  const sel=(preset.selection?.paths||[]).map(n);
  const exp=(preset.tree_view?.expanded_paths||[]).map(n);
  const missingSel=sel.filter(p=>p && !idx.all.has(p));
  const missingExp=exp.filter(p=>p && !idx.dirs.has(p));
  const mismatch=Boolean(preset.project_path && snapshot.projectPath && preset.project_path!==snapshot.projectPath);
  const status=mismatch?'broken':((missingSel.length||missingExp.length)?'partial':'ok');
  return {status, missingSel, missingExp};
}
function applyPreset(preset,snapshot,state){
  const idx=collectIndex(snapshot);
  state.expanded.clear();
  for(const p0 of preset.tree_view.expanded_paths||[]){ const p=n(p0); if(idx.dirs.has(p)) state.expanded.add(p); }
  state.selectedMode=preset.selection.mode==='selected'?'selected':'all';
  state.selected.clear();
  for(const p0 of preset.selection.paths||[]){
    const p=n(p0); if(!idx.all.has(p)) continue;
    state.selected.add(p);
    if(idx.dirs.has(p)) for(const d of collectDesc(snapshot,p)) if(idx.all.has(d)) state.selected.add(d);
  }
}

const snapshot={
  projectPath:'/p',
  tree:{isDir:true,absPath:'/p',children:[
    {isDir:true,absPath:'/p/f1',children:[{isDir:false,absPath:'/p/f1/a.txt',children:[]},{isDir:false,absPath:'/p/f1/b.txt',children:[]}]},
    {isDir:true,absPath:'/p/f2',children:[{isDir:false,absPath:'/p/f2/c.txt',children:[]}]},
    {isDir:false,absPath:'/p/root.txt',children:[]}
  ]}
};

const preset={
  schema_version:'export_preset_v1',
  project_path:'/p',
  export_profile:{format:'json',content_level:'full',include_tree:true,include_hashes:false,include_ignored_summary:true,sort_mode:'alpha'},
  selection:{mode:'selected',paths:['/p/f1','/p/root.txt','/p/missing.txt']},
  tree_view:{expanded_paths:['/p/f1','/p/missingDir'],scroll_hint:10},
  rehydration:{apply_on_refresh:true,cleanup_missing_paths:true}
};

const state={expanded:new Set(),selected:new Set(),selectedMode:'all',refreshCycleToken:1,lastAppliedCycleToken:0,pendingAutoApply:true};
applyPreset(preset,snapshot,state);
assert(state.expanded.has('/p/f1'));
assert(!state.expanded.has('/p/missingDir'));
assert(state.selected.has('/p/root.txt'));
assert(state.selected.has('/p/f1/a.txt') && state.selected.has('/p/f1/b.txt'));
assert(!state.selected.has('/p/missing.txt'));

const h=evaluateHealth(preset,snapshot);
assert.strictEqual(h.status,'partial');

function maybeAutoApply(st){
  if(!st.pendingAutoApply) return false;
  if(st.lastAppliedCycleToken===st.refreshCycleToken) return false;
  st.pendingAutoApply=false; st.lastAppliedCycleToken=st.refreshCycleToken; return true;
}
assert.strictEqual(maybeAutoApply(state), true);
assert.strictEqual(maybeAutoApply(state), false);

console.log('PASS preset apply mock assertions');
