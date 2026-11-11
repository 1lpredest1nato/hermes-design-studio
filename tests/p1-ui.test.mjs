import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,Module} from 'node:module';
const require=createRequire('/home/destino/.hermes/hermes-agent/apps/desktop/package.json');
const React=require('react');
const {transformSync}=require('esbuild');
const {JSDOM}=require('jsdom');
const {createRoot}=require('react-dom/client');
const {act}=React;
const root = new URL('../', import.meta.url);
// Test-only in-memory JSX transform: no bundle or installed plugin is changed.
async function loadUI(sdk) {
 const source=await readFile(new URL('hermes/studio-page.jsx',root),'utf8').catch(()=> '');
 const helper=await controls();const uploads=await import(new URL('hermes/upload.mjs',root));
 const compiled=transformSync(source,{loader:'jsx',format:'cjs',jsx:'automatic'}).code;
 const mod=new Module(new URL('hermes/studio-page.test.cjs',root).pathname);
 mod.require=id=>id==='@hermes/plugin-sdk'?sdk:id==='./controls.jsx'?helper:id==='./upload.mjs'?uploads:require(id);
 mod._compile(compiled,mod.filename||'studio-page.test.cjs');return mod.exports;
}
function sdkPrimitives() {
 const primitive=tag=>React.forwardRef(({children,variant,size,loading,asChild,...props},ref)=>React.createElement(tag,{...props,ref},children));
 const sdk={Button:primitive('button'),Input:primitive('input'),Textarea:primitive('textarea'),
 KEYBINDS_AREA:'keybinds',host:{navigate(){}},
 useQuery({queryFn}) {const [data,setData]=React.useState();const [error,setError]=React.useState();const refetch=async()=>{try{const data=await queryFn();setData(data);return {data};}catch(e){setError(e);return {error:e};}};sdk.refetch=refetch;React.useEffect(()=>{void refetch();},[]);return {data,error,isLoading:!data&&!error,refetch};}};return sdk;
}
async function mountStudio() {
 const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost/'});
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.HTMLElement=dom.window.HTMLElement;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 globalThis.ResizeObserver=class{observe(){}disconnect(){}};
 const sdk=sdkPrimitives();const ui=await loadUI(sdk);assert.equal(typeof ui.StudioPage,'function','StudioPage feature missing');
 let doc={id:'test',format:1,revision:0,stack:[],source:null,seed:1,timeline:null};
 const catalog={tools:[{ref:'builtin/grain@1',manifest:{id:'builtin/grain',name:'Grain',params:[{name:'amount',type:'float',min:0,max:1,default:0.5}]}}],drafts:[],recipes:[]};
 const calls=[],registered=[],disposed=[],renders=[];
 const service={signal:new AbortController().signal,renderer:{maxTextureSize:4096},metadata:()=>({run_id:'test'}),
 page(active){calls.push({page:active});},report:async()=>{},subscribe:()=>()=>{},getSnapshot:()=>({}),
 getState:async()=>({document:structuredClone(doc),catalog}),renderProject:async(doc,opts)=>{renders.push({doc,opts});throw new Error('GPU intentionally absent in DOM contract test');},
 rest:async(path,opts)=>{calls.push({path,...opts});if(path==='/commands')doc={...doc,revision:doc.revision+1,stack:[{uid:'new',tool:'builtin/grain@1',params:{amount:0.5},enabled:true,opacity:1,blend:'normal'}]};return {document:doc};}};
 const ctx={storage:{get:(_,fallback)=>fallback,set(){}},register(c){registered.push(c);return()=>disposed.push(c.id);},os:{revealPath:async()=>false}};
 const root=createRoot(document.getElementById('root'));
 await act(async()=>{root.render(React.createElement(ui.StudioPage,{service,ctx}));});
 return {dom,root,service,catalog,ctx,sdk,renders,calls,registered,disposed,async cleanup(){await act(async()=>root.unmount());dom.window.close();}};
}
test('manual studio renders useful empty states, sends backend add, and retires route keybinds',async()=>{
 const h=await mountStudio();
 try {
  assert.match(document.body.textContent,/Operations/);assert.match(document.body.textContent,/Tools/);assert.match(document.body.textContent,/Recipes/);assert.match(document.body.textContent,/Drafts/);
  assert.ok(document.querySelector('input[type=file][accept="image/*"]'));
  assert.match(document.body.textContent,/test image/i);
  const add=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Add Grain');assert.ok(add,'manual add tool action');
  await act(async()=>{add.click();});
  const sent=h.calls.find(c=>c.path==='/commands');assert.equal(sent.body.project_id,'test');assert.equal(sent.body.base_revision,0);assert.deepEqual(sent.body.commands,[{type:'add_node',tool:'builtin/grain@1'}]);
  assert.equal(h.registered.length,2);assert.deepEqual(h.registered.map(c=>c.data.defaults),[['mod+z'],['mod+shift+z']]);
  assert.ok(h.registered.every(c=>c.area==='keybinds'&&typeof c.data.run==='function'));
  assert.match(document.body.textContent,/GPU intentionally absent/,'render failures remain visible');
 }finally{await h.cleanup();}
 assert.equal(h.disposed.length,2);assert.equal(h.calls.at(-1).page,false);
});
async function controls() {
 const source = await readFile(new URL('hermes/controls.jsx',root),'utf8').catch(()=> '');
 return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}
test('before comparison renders are excluded from project history metrics',async()=>{
 const h=await mountStudio();try{assert.ok(h.renders.some(r=>r.opts.comparison===true),'before-frame render must not overwrite previous-revision metrics');}finally{await h.cleanup();}
});
test('numeric conversion never silently rounds invalid integer input',async()=>{
 const m=await controls();assert.equal(m.paramValue({type:'int'},'1.5'),1.5,'backend validates integer semantics; UI must preserve the submitted number');
});

test('same-revision polling cannot cancel an in-flight client export',async()=>{
 const h=await mountStudio();let finish;
 try{
  h.service.renderProject=async()=>new Promise(resolve=>finish=resolve);
  await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Prepare PNG').click());
  await act(async()=>h.sdk.refetch());
  await act(async()=>finish({blob:new Blob(['png']),width:16,height:16}));
  assert.ok(document.querySelector('a[download]'),'same revision must preserve document identity for in-flight work');
 }finally{await h.cleanup();}
});

test('Native colors depend only on SDK ui tokens and Minimal persists without touching host DOM',async()=>{
 const source=await readFile(new URL('hermes/studio-page.jsx',root),'utf8');
 const css=source.match(/const CSS=`([\s\S]*?)`;/)[1];const native=css.replace(/\.hds\[data-theme=minimal\]\{[^}]*\}/g,'');
 assert.doesNotMatch(native,/#[0-9a-f]{3,8}\b|rgba?\(|(?:color|background):\s*(?:black|white)\b/i);
 assert.doesNotMatch(native,/var\(--(?!ui-)[a-z-]+\)/,'Native references only SDK --ui-* tokens');
 const h=await mountStudio();const writes=[];h.ctx.storage.set=(...args)=>writes.push(args);
 try{const select=document.querySelector('select[aria-label="Interface theme"]');await act(async()=>{select.value='minimal';select.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));});assert.equal(document.querySelector('main').dataset.theme,'minimal');assert.deepEqual(writes,[['theme','minimal']]);assert.equal(document.documentElement.getAttribute('data-theme'),null);}finally{await h.cleanup();}
});

test('a new revision invalidates exports and clears an obsolete export task',async()=>{
 const h=await mountStudio();let finish;
 try{
  h.service.renderProject=async()=>new Promise(resolve=>finish=resolve);
  const prepare=[...document.querySelectorAll('button')].find(b=>b.textContent==='Prepare PNG');await act(async()=>prepare.click());assert.equal(prepare.disabled,true);
  const add=document.querySelector('[aria-label="Add Grain"]');await act(async()=>add.click());
  await act(async()=>finish({blob:new Blob(['png']),width:16,height:16}));
  assert.equal(document.querySelector('a[download]'),null,'a new backend revision invalidates old export');
  const current=[...document.querySelectorAll('button')].find(b=>b.textContent==='Prepare PNG');assert.ok(current&&!current.disabled,'obsolete preparation must not leave export permanently busy');
 }finally{await h.cleanup();}
});
test('gesture backlog keeps only the latest pending payload without altering backend documents',async()=>{
 const m=await controls();let doc={id:'test',revision:0};let release;const first=new Promise(r=>release=r),calls=[];
 const channel=m.createCommandChannel({now:()=>1000,wait:async()=>{},getDocument:()=>doc,onDocument:d=>doc=d,rest:async(path,opts)=>{calls.push(opts.body);if(calls.length===1)await first;return {document:{id:opts.body.project_id,revision:opts.body.base_revision+1}};}});
 const one=channel.send([{type:'set_params',uid:'n',params:{x:1}}],'gesture');
 const two=channel.send([{type:'set_params',uid:'n',params:{x:2}}],'gesture');
 const three=channel.send([{type:'set_params',uid:'n',params:{x:3}}],'gesture');
 release();await Promise.all([one,two,three]);assert.equal(calls.length,2);assert.equal(calls[1].commands[0].params.x,3);assert.equal(doc.revision,2);channel.dispose();
});
test('draft failure keeps exact compiler line diagnostics and prevents approval',async()=>{
 const h=await mountStudio();let checks=0;
 try{
  h.service.rest=async(path,opts)=>({manifest:{id:'user/my-tool',name:'My tool',params:[],version:1},shader:opts?.body?.shader});
  h.service.checkDraft=async()=>{checks++;throw new Error('ERROR: 0:7: syntax error at outColor');};
  await act(async()=>[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='Drafts').click());
  await act(async()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='New tool').click());
  await act(async()=>{await new Promise(r=>setTimeout(r,700));});
  assert.equal(checks,1);assert.match(document.body.textContent,/ERROR: 0:7: syntax error/);assert.equal([...document.querySelectorAll('button')].find(b=>b.textContent==='Approve tool').disabled,true);
 }finally{await h.cleanup();}
});

test('recipe saving sends the selected stack and explicit exposed descriptors through the API',async()=>{
 const h=await mountStudio();let saved;
 try{
  const add=document.querySelector('[aria-label="Add Grain"]');await act(async()=>add.click());
  const original=h.service.rest;h.service.rest=async(path,opts)=>{if(path==='/recipes'){saved=opts.body;const recipe={format:1,id:'recipe/my-recipe',...opts.body};h.catalog.recipes.push(recipe);return recipe;}return original(path,opts);};
  const tab=[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='Recipes');await act(async()=>tab.click());
  const exposure=document.querySelector('input[aria-label="Expose amount from operation 1"]');assert.ok(exposure,'user-selectable exposed parameter');await act(async()=>exposure.click());
  const save=[...document.querySelectorAll('button')].find(b=>b.textContent==='Save recipe');assert.ok(save);await act(async()=>save.click());
  assert.equal(saved.name,'My recipe');assert.equal(saved.stack[0].uid,'new');assert.equal(saved.stack[0].tool,'builtin/grain@1');
  assert.deepEqual(saved.exposed,[{name:'control1',node_uid:'new',param:'amount'}]);
  const apply=[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='Apply My recipe');assert.ok(apply);await act(async()=>{apply.click();await new Promise(r=>setTimeout(r,80));});
  const sent=h.calls.find(c=>c.path==='/recipes/apply');assert.ok(sent);assert.deepEqual(sent.body,{id:'recipe/my-recipe',project_id:'test',base_revision:1});
 }finally{await h.cleanup();}
});

test('manual shader editor checks both fixtures after debounce and approves only on a human click',async()=>{
 const h=await mountStudio();const checked=[],writes=[];
 try{
  const original=h.service.rest;
  h.service.rest=async(path,opts)=>{writes.push({path,...opts});if(path==='/drafts')return {manifest:{id:'user/my-tool',name:opts.body.name,params:opts.body.params,version:1},shader:opts.body.shader,status:'draft',ref:'user/my-tool@1',expected_shader_sha:'a'.repeat(64),expected_manifest_sha:'b'.repeat(64)};return original(path,opts);};
  h.service.checkDraft=async(entry,opts)=>{checked.push({entry,opts});const request_id='check-'+checked.length;return {frame:{blob:new Blob(['png']),width:16,height:16},entry,request:{request_id,entry,shader_sha:entry.expected_shader_sha},check:{request_id,shader_sha:entry.expected_shader_sha}};};
  globalThis.createImageBitmap=async()=>({width:16,height:16,close(){}});h.dom.window.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
  const drafts=[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent==='Drafts');await act(async()=>drafts.click());
  const create=[...document.querySelectorAll('button')].find(b=>b.textContent==='New tool');assert.ok(create,'manual shader creation');await act(async()=>create.click());
  assert.ok(document.querySelector('textarea[aria-label="GLSL fragment shader"]'));
  const add=[...document.querySelectorAll('button')].find(b=>b.textContent==='Add parameter');assert.ok(add);
  await act(async()=>add.click());
  const type=document.querySelector('select[aria-label="Parameter 1 type"]');assert.ok(type);assert.deepEqual([...type.options].map(o=>o.value),['float','int','bool','color','enum']);
  let approve=[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve tool');assert.ok(approve.disabled);
  await act(async()=>{await new Promise(r=>setTimeout(r,750));});
  assert.equal(checked.length,2);assert.deepEqual(checked.map(c=>Boolean(c.opts.fixture)),[false,true]);
  assert.equal(writes.filter(w=>w.path==='/drafts/approve').length,0,'compilation must never approve');
  approve=[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve tool');assert.equal(approve.disabled,false);
  await act(async()=>approve.click());assert.equal(writes.filter(w=>w.path==='/drafts/approve').length,1);
  assert.deepEqual(writes.find(w=>w.path==='/drafts/approve').body,{id:'user/my-tool',expected_shader_sha:'a'.repeat(64),expected_manifest_sha:'b'.repeat(64)});
 }finally{await h.cleanup();delete globalThis.createImageBitmap;}
});

test('file input drives real chunk transport and full-resolution export is client download only',async()=>{
 const h=await mountStudio();const requests=[];
 try {
  const file=new Blob([new Uint8Array(4*1024*1024+1)],{type:'image/png'});
  globalThis.createImageBitmap=async()=>({width:64,height:32,close(){}});
  h.dom.window.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
  h.dom.window.HTMLCanvasElement.prototype.toBlob=function(fn){fn(file);};
  h.service.rest=async(path,opts)=>{requests.push({path,...opts});if(path.startsWith('/assets/upload')){const query=new URL(path,'http://local').searchParams;return {sha256:query.get('sha256'),asset:'assets/upload.png'};}return {document:{id:'test',revision:1,source:{asset:'assets/upload.png',w:64,h:32},stack:[]}};};
  // The transport captured its rest on mount; the upload path reads the live service rest.
  const input=document.querySelector('input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:[file]});
  await act(async()=>{input.dispatchEvent(new h.dom.window.Event('change',{bubbles:true}));await new Promise(r=>setTimeout(r,60));});
  assert.equal(requests.filter(r=>r.path.startsWith('/assets/upload')).length,2,'real uploadChunks must send two chunks');
  const uploadRequests=requests.filter(r=>r.path.startsWith('/assets/upload'));assert.equal(uploadRequests[0].upload.bytes.byteLength,4*1024*1024);assert.equal(uploadRequests[1].upload.bytes.byteLength,1);
  assert.ok(h.calls.some(c=>c.path==='/commands'&&c.body.commands[0].type==='set_source'));
  const save=[...document.querySelectorAll('button')].find(b=>/Prepare PNG/.test(b.textContent));assert.ok(save,'explicit full-resolution preparation action');
  const renders=[];h.service.renderProject=async(doc,opts)=>{renders.push(opts);return {blob:new Blob(['png']),width:64,height:32};};
  await act(async()=>save.click());
  const link=document.querySelector('a[download]');assert.ok(link,'user must click the prepared native download link');assert.match(link.textContent,/Save as/);assert.ok(renders.some(o=>o.kind==='export'));
  assert.ok(!requests.some(r=>r.path==='/render/response'),'client Save as is not a gateway export');
 }finally{await h.cleanup();delete globalThis.createImageBitmap;}
});

test('image import shows the decoded file before PNG chunk upload and sets backend source',async()=>{
 const m=await controls();assert.equal(typeof m.importImage,'function','manual import missing');
 const order=[],commands=[];const file=new Blob(['source']);
 const bitmap={width:32,height:24,close(){order.push('close');}};
 const png=new Blob(['png'],{type:'image/png'});
 await m.importImage(file,{signal:new AbortController().signal,maxTextureSize:4096,
  decode:async f=>{assert.equal(f,file);order.push('decode');return bitmap;},
  show:frame=>{assert.equal(frame.blob,file);order.push('show');},
  encode:async b=>{assert.equal(b,bitmap);order.push('encode');return png;},
  upload:async b=>{assert.equal(b,png);order.push('upload');return {receipt:{asset:'assets/image.png'},sha256:'sha'};},
  send:async c=>{commands.push(c);order.push('command');}});
 assert.deepEqual(order,['decode','show','encode','upload','command','close']);
 assert.deepEqual(commands,[[{type:'set_source',source:{asset:'assets/image.png',w:32,h:24}}]]);
});
test('oversized and cancelled imports never upload or change source',async()=>{
 const m=await controls();assert.equal(typeof m.importImage,'function','manual import missing');
 let uploaded=false,closed=false;const opts={maxTextureSize:8,signal:new AbortController().signal,decode:async()=>({width:9,height:2,close(){closed=true;}}),upload:async()=>uploaded=true};
 await assert.rejects(m.importImage(new Blob(['x']),opts),/texture limit.*8/i);assert.equal(uploaded,false);assert.equal(closed,true);
 const controller=new AbortController();controller.abort();await assert.rejects(m.importImage(new Blob(['x']),{...opts,signal:controller.signal}),/cancelled/i);
});

test('manifest controls preserve all five parameter types and enum values', async()=>{
 const m=await controls();
 assert.equal(typeof m.paramValue,'function','manifest parameter conversion is missing');
 assert.equal(m.paramValue({type:'float'},'0.25'),0.25);
 assert.equal(m.paramValue({type:'int'},'7'),7);
 assert.equal(m.paramValue({type:'bool'},false),false);
 assert.equal(m.paramValue({type:'color'},'#edcba9'),'#edcba9');
 assert.equal(m.paramValue({type:'enum',options:['soft','hard']},'hard'),'hard');
 assert.throws(()=>m.paramValue({type:'float'},''),/number/i);
 assert.deepEqual(m.paramDefaults([{name:'n',default:0},{name:'on',default:false}]),{n:0,on:false});
});
test('command channel serializes backend revisions, rate limits, and merges only pending gestures',async()=>{
 const m=await controls();assert.equal(typeof m.createCommandChannel,'function','command transport missing');
 let doc={id:'test',revision:4},clock=0;const calls=[],sleeps=[];
 const c=m.createCommandChannel({getDocument:()=>doc,onDocument:d=>doc=d,
  wait:async ms=>{sleeps.push(ms);clock+=ms;},now:()=>clock,
  rest:async(path,opts)=>{calls.push({path,...opts.body});return {document:{id:opts.body.project_id,revision:opts.body.base_revision+1}};}});
 await c.send([{type:'set_params',uid:'n',params:{x:1}}],'drag-1');
 await c.send([{type:'set_params',uid:'n',params:{x:2}}],'drag-1');
 assert.deepEqual(calls.map(x=>x.base_revision),[4,5]);
 assert.equal(calls[0].gesture_id,'drag-1');assert.ok(sleeps[0]>=1000/15);
 assert.deepEqual(calls[1].commands,[{type:'set_params',uid:'n',params:{x:2}}]);
 assert.equal(doc.revision,6);c.dispose();
 await assert.rejects(c.send([{type:'set_seed',seed:2}]),/closed/i);
});
for(const path of ['/commands','/history/undo','/history/redo','/recipes/apply']) {
 test(`command channel binds ${path} identity and revision to one document snapshot`,async()=>{
  const m=await controls();let reads=0;const calls=[];
  const c=m.createCommandChannel({getDocument:()=>{reads++;return {id:`snapshot-${reads}`,revision:reads};},onDocument:()=>{},
   rest:async(path,opts)=>{calls.push({path,...opts.body});return {document:{id:opts.body.project_id,revision:opts.body.base_revision+1}};}});
  try {
   if(path==='/commands')await c.send([{type:'set_seed',seed:3}]);
   else await c.action(path,{id:'recipe/test',project_id:'untrusted-override',base_revision:999});
   assert.equal(reads,1);assert.equal(calls[0].project_id,'snapshot-1');assert.equal(calls[0].base_revision,1);
  }finally{c.dispose();}
 });
}
test('equal-revision different-project HTTP409 refreshes identity and rejects queued edits without retry',async()=>{
 const m=await controls();let doc={id:'old',revision:0},release,notifications=0;const calls=[];
 const blocked=new Promise(resolve=>release=resolve);
 const current={id:'new',revision:0,stack:[]};
 const c=m.createCommandChannel({getDocument:()=>doc,onDocument:d=>doc=d,onConflict:()=>notifications++,
  rest:async(path,opts)=>{calls.push(opts.body);await blocked;throw Object.assign(new Error('HTTP 409 project identity conflict'),{status:409,document:current});},
  refresh:async()=>{throw new Error('409 document should be used directly');}});
 const first=c.send([{type:'set_seed',seed:1}]);
 const queued=c.action('/history/undo');
 const failures=Promise.all([assert.rejects(first,/409/),assert.rejects(queued,/409/)]);
 release();await failures;
 assert.deepEqual(calls.map(x=>({project_id:x.project_id,base_revision:x.base_revision})),[{project_id:'old',base_revision:0}]);
 assert.deepEqual(doc,current);assert.equal(notifications,1);c.dispose();
});

test('queued New project rejects old-project seed and pending edits without posting or retrying',async()=>{
 const m=await controls();let doc={id:'A',revision:0},release,refreshes=0,conflicts=0;const calls=[];
 const blocked=new Promise(resolve=>release=resolve),current={id:'B',revision:0};
 const c=m.createCommandChannel({now:()=>1000,wait:async()=>{},getDocument:()=>doc,onDocument:d=>doc=d,
  refresh:async()=>{refreshes++;return {document:current};},onConflict:()=>conflicts++,
  rest:async(path,opts)=>{calls.push({path,...opts.body});if(path==='/project/new'){await blocked;return {document:current};}return {document:{id:opts.body.project_id,revision:opts.body.base_revision+1}};}});
 try {
  const first=c.action('/project/new');
  const stale=c.send([{type:'set_seed',seed:42}]);
  const pending=c.action('/history/undo');
  const failures=Promise.all([assert.rejects(stale,{status:409}),assert.rejects(pending,{status:409})]);
  release();await first;await failures;
  assert.deepEqual(calls,[{path:'/project/new',project_id:'A',base_revision:0}]);
  assert.deepEqual(doc,current);assert.equal(refreshes,1);assert.equal(conflicts,1);
 }finally{c.dispose();}
});

test('throttled job rejects a project switch during its wait without a POST',async()=>{
 const m=await controls();let doc={id:'A',revision:0},release,conflicts=0,refreshes=0;const calls=[];
 const blocked=new Promise(resolve=>release=resolve);
 const c=m.createCommandChannel({now:()=>0,wait:()=>blocked,getDocument:()=>doc,onDocument:d=>doc=d,
  refresh:async()=>{refreshes++;return {document:doc};},onConflict:()=>conflicts++,
  rest:async(path,opts)=>{calls.push(opts.body);return {document:{id:opts.body.project_id,revision:opts.body.base_revision+1}};}});
 try {
  await c.send([{type:'set_seed',seed:1}]);
  const stale=c.send([{type:'set_seed',seed:42}]);
  const pending=c.action('/history/undo');
  const failures=Promise.all([assert.rejects(stale,{status:409}),assert.rejects(pending,{status:409})]);
  doc={id:'B',revision:0};release();await failures;
  assert.equal(calls.length,1);assert.equal(calls[0].project_id,'A');
  assert.deepEqual(doc,{id:'B',revision:0});assert.equal(conflicts,1);assert.equal(refreshes,1);
 }finally{c.dispose();}
});

test('same gesture across project identities cannot replace an earlier queued payload',async()=>{
 const m=await controls();let doc={id:'A',revision:0},release,conflicts=0;const calls=[];
 const blocked=new Promise(resolve=>release=resolve);
 const c=m.createCommandChannel({now:()=>1000,wait:async()=>{},getDocument:()=>doc,onDocument:d=>doc=d,
  refresh:async()=>({document:doc}),onConflict:()=>conflicts++,
  rest:async(path,opts)=>{calls.push(opts.body);if(calls.length===1)await blocked;return {document:{id:opts.body.project_id,revision:opts.body.base_revision+1}};}});
 try {
  const first=c.send([{type:'set_seed',seed:1}]);
  const earlier=c.send([{type:'set_seed',seed:2}],'drag');
  doc={id:'B',revision:0};
  const later=c.send([{type:'set_seed',seed:3}],'drag');
  const failure=assert.rejects(later,{status:409});
  release();await Promise.all([first,earlier,failure]);
  assert.deepEqual(calls.map(c=>[c.project_id,c.base_revision,c.commands[0].seed]),[['A',0,1],['A',1,2]]);
  assert.equal(conflicts,1);
 }finally{c.dispose();}
});

test('revision conflicts refresh the authoritative document and never silently retry',async()=>{
 const m=await controls();assert.equal(typeof m.createCommandChannel,'function','command transport missing');
 let doc={id:'test',revision:1},notified=false,calls=0;
 const c=m.createCommandChannel({getDocument:()=>doc,onDocument:d=>doc=d,
  refresh:async()=>({document:{id:'test',revision:8}}),onConflict:()=>notified=true,
  rest:async()=>{calls++;throw Object.assign(new Error('HTTP 409 revision conflict'),{status:409});}});
 await assert.rejects(c.send([{type:'remove_node',uid:'x'}]),/409/);
 assert.equal(doc.revision,8);assert.equal(notified,true);assert.equal(calls,1);c.dispose();
});

test('project creation and reproducible seed are available without any agent',async()=>{
 const h=await mountStudio();
 try {
  const create=[...document.querySelectorAll('button')].find(b=>b.textContent==='New project');
  assert.ok(create,'manual new-project action missing');
  await act(async()=>create.click());
  assert.ok(h.calls.some(c=>c.path==='/project/new'));
  const seed=[...document.querySelectorAll('button')].find(b=>b.textContent==='Next seed');
  assert.ok(seed,'manual seed action missing');
  await act(async()=>{seed.click();await new Promise(r=>setTimeout(r,80));});
  assert.ok(h.calls.some(c=>c.path==='/commands'&&c.body.commands[0].type==='set_seed'&&c.body.commands[0].seed===2));
  assert.ok(document.querySelector('input[aria-label="Seed exact value"]'));
 }finally{await h.cleanup();}
});
