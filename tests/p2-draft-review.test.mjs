import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,Module} from 'node:module';
const require=createRequire('/home/destino/.hermes/hermes-agent/apps/desktop/package.json');
const React=require('react'),{act}=React,{transformSync}=require('esbuild'),{JSDOM}=require('jsdom'),{createRoot}=require('react-dom/client');
const defaults=params=>Object.fromEntries((params||[]).map(p=>[p.name,p.default]));
async function mountEditor({fresh=false}={}) {
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,
 ResizeObserver:class{observe(){}disconnect(){}},createImageBitmap:async()=>({width:1,height:1,close(){}})});
 dom.window.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
 const primitive=tag=>({children,variant,size,...props})=>React.createElement(tag,props,children);
 const sdk={Button:primitive('button'),Input:primitive('input'),Textarea:primitive('textarea')};
 const source=(await readFile(new URL('../hermes/studio-page.jsx',import.meta.url),'utf8'))+'\nexport {DraftEditor};';
 const mod=new Module('draft-review.cjs');mod.require=id=>id==='@hermes/plugin-sdk'?sdk:id==='./controls.jsx'?{paramDefaults:defaults,paramValue:(p,v)=>Number(v)}:id==='./upload.mjs'?{}:require(id);
 mod._compile(transformSync(source,{loader:'jsx',format:'cjs',jsx:'automatic'}).code,'draft-review.cjs');
 const entry={manifest:{id:'user/agent-draft',name:'Agent draft',params:[{name:'amount',type:'float',min:0,max:1,default:0.5}],provenance:{author:'agent'}},shader:'void main(){}',expected_shader_sha:'a'.repeat(64),expected_manifest_sha:'b'.repeat(64)};
 const calls=[],checks=[];let count=0,backend=entry,revision=0,hold=false,release;
 const service={signal:new AbortController().signal,rest:async(path,opts)=>{
 calls.push({path,opts});if(path==='/drafts'){const {shader,...manifest}=opts.body;backend={manifest:{...manifest,id:entry.manifest.id,provenance:{author:'user'}},shader,expected_shader_sha:'c'.repeat(64),expected_manifest_sha:'d'.repeat(64)};return backend;}return {};},
 checkDraft:async(draft,options)=>{checks.push({draft,options});if(hold){hold=false;await new Promise(resolve=>release=resolve);}
 if(draft.expected_manifest_sha!==backend.expected_manifest_sha)throw new Error('Draft snapshot changed');
 const request_id='check-'+(++count);return {frame:{blob:new Blob(['preview'])},entry:draft,request:{request_id,entry:draft,shader_sha:draft.expected_shader_sha},check:{request_id,shader_sha:draft.expected_shader_sha}};}};
 const root=createRoot(document.getElementById('root'));
 const render=()=>root.render(React.createElement(mod.exports.DraftEditor,{entry:fresh?null:entry,service,doc:{id:'p',revision},onRefresh:async()=>({catalog:{tools:[backend]}}),onClose(){}}));
 const wait=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,680));});
 await act(async()=>render());
 return {entry,calls,checks,wait,button:()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve tool'),
 change:async(label,value)=>{const node=document.querySelector(`[aria-label="${label}"]`);const props=node[Object.keys(node).find(k=>k.startsWith('__reactProps$'))];await act(async()=>props.onChange({target:{value}}));},
 revision:async()=>{revision++;await act(async()=>render());},replace:()=>{backend={...backend,expected_manifest_sha:'e'.repeat(64)};},
 hold:()=>{hold=true;},release:async()=>{await act(async()=>release());},cleanup:async()=>{await act(async()=>root.unmount());dom.window.close();}};
}
const saves=h=>h.calls.filter(c=>c.path==='/drafts');
const approvals=h=>h.calls.filter(c=>c.path==='/drafts/approve');
test('preview-only controls and document revisions recheck without rewriting the original snapshot',async()=>{
 const h=await mountEditor();try{await h.wait();await h.change('amount exact value','0.8');assert.equal(h.button().disabled,true);await h.wait();await h.revision();assert.equal(h.button().disabled,true);await h.wait();assert.equal(saves(h).length,0);assert.equal(h.checks.length,6);for(const c of h.checks)assert.equal(c.draft,h.entry);assert.equal(h.checks[2].options.params.amount,0.8);assert.equal(h.button().disabled,false);assert.equal(approvals(h).length,0);}finally{await h.cleanup();}
});
test('GLSL edits save once, invalidate approval immediately, and require fresh successful fingerprints',async()=>{
 const h=await mountEditor();try{await h.wait();h.hold();await h.change('GLSL fragment shader','void main(){ outColor=vec4(1.0); }');assert.equal(h.button().disabled,true);await h.wait();assert.equal(saves(h).length,1);assert.equal(h.button().disabled,true);assert.equal(approvals(h).length,0);await h.release();assert.equal(h.button().disabled,false);const saved=h.checks.at(-1).draft;assert.notEqual(saved.expected_shader_sha,h.entry.expected_shader_sha);assert.notEqual(saved.expected_manifest_sha,h.entry.expected_manifest_sha);
 await h.revision();await h.wait();assert.equal(saves(h).length,1);assert.equal(h.checks.at(-1).draft,saved);await act(async()=>h.button().click());assert.deepEqual(approvals(h)[0].opts.body,{id:saved.manifest.id,expected_shader_sha:saved.expected_shader_sha,expected_manifest_sha:saved.expected_manifest_sha});}finally{await h.cleanup();}
});
test('concurrent backend replacement is rejected rather than resaved over or approved',async()=>{
 const h=await mountEditor();try{await h.wait();h.replace();await h.revision();await h.wait();assert.equal(saves(h).length,0);assert.equal(h.button().disabled,true);assert.match(document.body.textContent,/snapshot changed/i);assert.equal(approvals(h).length,0);}finally{await h.cleanup();}
});
test('a new tool still saves its initial template once after the debounce',async()=>{
 const h=await mountEditor({fresh:true});try{assert.equal(saves(h).length,0);await h.wait();assert.equal(saves(h).length,1);assert.equal(saves(h)[0].opts.body.name,'My tool');assert.match(saves(h)[0].opts.body.shader,/texture\(u_input, v_uv\)/);assert.equal(h.button().disabled,false);await h.revision();await h.wait();assert.equal(saves(h).length,1);assert.equal(approvals(h).length,0);}finally{await h.cleanup();}
});
test('a superseded check cannot make an edited draft approvable',async()=>{
 const h=await mountEditor();try{h.hold();await h.wait();await h.change('GLSL fragment shader','void main(){ outColor=vec4(0.0); }');await h.release();assert.equal(h.button().disabled,true);assert.equal(h.checks.length,1);await h.wait();assert.equal(saves(h).length,1);assert.equal(h.button().disabled,false);assert.equal(approvals(h).length,0);}finally{await h.cleanup();}
});
test('opening an agent draft checks its original immutable snapshots without saving or auto-approval',async()=>{
 const h=await mountEditor();try{await h.wait();assert.equal(saves(h).length,0);assert.equal(h.checks.length,2);assert.deepEqual(h.checks.map(c=>c.options.fixture),[false,true]);for(const c of h.checks)assert.equal(c.draft,h.entry);assert.equal(approvals(h).length,0);assert.equal(h.button().disabled,false);
 await act(async()=>h.button().click());assert.deepEqual(approvals(h)[0].opts.body,{id:h.entry.manifest.id,expected_shader_sha:h.entry.expected_shader_sha,expected_manifest_sha:h.entry.expected_manifest_sha});
 }finally{await h.cleanup();}
});
