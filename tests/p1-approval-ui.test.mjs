import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire,Module} from 'node:module';
const require=createRequire('/home/destino/.hermes/hermes-agent/apps/desktop/package.json');
const React=require('react'),{act}=React,{transformSync}=require('esbuild'),{JSDOM}=require('jsdom'),{createRoot}=require('react-dom/client');
async function mountEditor(mode='exact') {
 const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost/'});
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true,
 ResizeObserver:class{observe(){}disconnect(){}},createImageBitmap:async()=>({width:1,height:1,close(){}})});
 dom.window.HTMLCanvasElement.prototype.getContext=()=>({drawImage(){}});
 const primitive=tag=>({children,variant,size,...props})=>React.createElement(tag,props,children);
 const sdk={Button:primitive('button'),Input:primitive('input'),Textarea:primitive('textarea')};
 const source=(await readFile(new URL('../hermes/studio-page.jsx',import.meta.url),'utf8'))+'\nexport {DraftEditor};';
 const mod=new Module('approval-ui.cjs');mod.require=id=>id==='@hermes/plugin-sdk'?sdk:id==='./controls.jsx'?{paramDefaults:()=>({})}:id==='./upload.mjs'?{}:require(id);
 mod._compile(transformSync(source,{loader:'jsx',format:'cjs',jsx:'automatic'}).code,'approval-ui.cjs');
 const entry={manifest:{id:'user/snapshot',name:'Snapshot',params:[],description:''},shader:'void main(){}',expected_shader_sha:'a'.repeat(64),expected_manifest_sha:'b'.repeat(64)};
 const calls=[];let count=0;
 const service={signal:new AbortController().signal,rest:async(path,opts)=>{calls.push({path,opts});if(path==='/drafts')return entry;if(mode==='approval-conflict')throw new Error('manifest snapshot changed');return {};},
 checkDraft:async()=>{const request_id='check-'+(++count);const validated=mode==='replacement'?{...entry,expected_manifest_sha:'c'.repeat(64)}:entry;
 return {frame:{blob:new Blob(['preview'])},entry:validated,request:{request_id,entry:validated,shader_sha:validated.expected_shader_sha},check:{request_id:mode==='wrong-receipt'?'unrelated':request_id,shader_sha:validated.expected_shader_sha}};}};
 const root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(React.createElement(mod.exports.DraftEditor,{entry,service,doc:{id:'p',revision:0},onRefresh:async()=>({catalog:{tools:[]}}),onClose(){}})));
 await act(async()=>{await new Promise(resolve=>setTimeout(resolve,680));});
 return {calls,entry,button:()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='Approve tool'),cleanup:async()=>{await act(async()=>root.unmount());dom.window.close();}};
}
test('human approval sends the exact displayed successful check fingerprints',async()=>{
 const h=await mountEditor();try{assert.equal(h.button().disabled,false);await act(async()=>h.button().click());
 assert.deepEqual(h.calls.find(c=>c.path==='/drafts/approve').opts.body,{id:h.entry.manifest.id,expected_shader_sha:h.entry.expected_shader_sha,expected_manifest_sha:h.entry.expected_manifest_sha});
 }finally{await h.cleanup();}
});
for(const mode of ['replacement','wrong-receipt','approval-conflict'])test(`approval stays disabled after ${mode}`,async()=>{
 const h=await mountEditor(mode);try{if(mode==='approval-conflict')await act(async()=>h.button().click());assert.equal(h.button().disabled,true);assert.match(document.body.textContent,/snapshot|identity/i);}finally{await h.cleanup();}
});
