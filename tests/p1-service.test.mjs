import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

test('asset transport reads bounded base64 chunks, verifies full content hash and aborts',async()=>{
 const mod=await import('../hermes/assets.mjs').catch(()=>({}));
 assert.equal(typeof mod.loadAsset,'function','bounded asset transport missing');
 const data=Buffer.from('real-byte-fixture');const sha=createHash('sha256').update(data).digest('hex');
 const calls=[];
 const rest=async path=>{
  calls.push(path);const query=new URLSearchParams(path.split('?')[1]);const offset=Number(query.get('offset'));
  const bytes=data.subarray(offset,offset+5);
  return {offset,total:data.length,mime:'image/png',base64:bytes.toString('base64'),bytes:bytes.length};
 };
 const blob=await mod.loadAsset(rest,'assets/'+sha+'.png',new AbortController().signal);
 assert.deepEqual(Buffer.from(await blob.arrayBuffer()),data);assert.equal(calls.length,4);
 const controller=new AbortController();controller.abort();
 await assert.rejects(()=>mod.loadAsset(rest,'assets/'+sha+'.png',controller.signal),/abort|cancel/i);
 await assert.rejects(()=>mod.loadAsset(rest,'../private',new AbortController().signal),/asset/);
 await assert.rejects(()=>mod.loadAsset(rest,'assets/'+'0'.repeat(64)+'.png',new AbortController().signal),/hash/);
});

test('project render is serialized and explicit preview limit reaches core',async()=>{
 const {createService}=await import('../hermes/service.mjs');
 const seen=[];let disposed=false;
 const ctx={rest:async()=>({tools:[]}),onDispose:()=>{}};
 const renderer={render:async(doc,time,options)=>{seen.push({doc,time,options});return {blob:new Blob(['fixture']),metrics:{},width:2,height:2,rgba:new Uint8Array(16)};},dispose:()=>disposed=true};
 const service=createService(ctx,renderer,{runId:'p1',build:'p1'});
 assert.equal(typeof service.renderProject,'function','project render orchestration missing');
 const doc={format:1,id:'a',revision:0,stack:[],source:null,seed:0,timeline:null};
 const frame=await service.renderProject(doc,{max_size:800});
 assert.equal(frame.width,2);assert.equal(seen[0].time,0);assert.equal(seen[0].options.max_size,800);
 service.dispose();assert.equal(disposed,true);
 await assert.rejects(()=>service.renderProject(doc),/unloaded|disposed/i);
});

test('background request loads catalogue and honestly marks a source-less fixture',async()=>{
 const {createService}=await import('../hermes/service.mjs');const calls=[];let seen;
 const entry={ref:'builtin/levels@1',manifest:{id:'builtin/levels',version:1},shader:'void main(){}'};
 const ctx={onDispose:()=>{},rest:async(path,opts)=>{calls.push({path,opts});if(path==='/catalog')return {tools:[entry]};return {ok:true};}};
 const renderer={render:async(doc,time,opts)=>{seen=opts;return {blob:new Blob(['actual-render-seam']),width:2,height:2,metrics:{},fixture:false};},dispose(){}};
 const service=createService(ctx,renderer,{runId:'actual',build:'p1'});
 const doc={format:1,id:'project-a',revision:4,source:null,stack:[{uid:'n',tool:entry.ref,params:{}}],timeline:null,seed:1};
 await service.accept({requests:[{request_id:'r2',kind:'preview',document:doc,max_size:700}]});
 assert.deepEqual(seen.tools,[entry]);assert.equal(seen.max_size,700);
 const upload=calls.find(c=>c.path.startsWith('/render/response'));
 const meta=JSON.parse(new URLSearchParams(upload.path.split('?')[1]).get('meta'));
 assert.equal(meta.project_id,'project-a');assert.equal(meta.fixture,true);
 service.dispose();
});

test('cache keys include project identity and metrics compare previous revision not repeated frame',async()=>{
 const {createService}=await import('../hermes/service.mjs');const seen=[];
 const ctx={onDispose:()=>{},rest:async()=>({ok:true})};
 const renderer={render:async(doc,time,opts)=>{seen.push({id:doc.id,revision:doc.revision,previous:opts.previous});return {blob:new Blob(['frame']),width:1,height:1,metrics:{},rgba:new Uint8Array([doc.revision,0,0,255])};},dispose(){}};
 const service=createService(ctx,renderer,{runId:'frames',build:'p1'});
 const doc={format:1,id:'a',revision:1,stack:[],source:null,seed:1,timeline:null};
 await service.renderProject(doc);await service.renderProject({...doc,revision:2});await service.renderProject({...doc,revision:2});
 assert.equal(seen[1].previous.rgba[0],1);assert.equal(seen[2].previous.rgba[0],1);
 await service.cache({...doc,id:'b',revision:0});await service.cache({...doc,id:'c',revision:0});
 assert.equal(seen.filter(x=>x.id==='b'||x.id==='c').length,2);
 service.dispose();
});

test('compiler errors finish checks as errors once instead of leaving requests pending',async()=>{
 const {createService}=await import('../hermes/service.mjs');const calls=[];let renders=0;
 const ctx={onDispose:()=>{},rest:async(path,opts)=>{calls.push({path,opts});return {ok:true};}};
 const renderer={render:async()=>{renders++;throw new Error('ERROR: 0:5: syntax error');},dispose(){}};
 const service=createService(ctx,renderer,{runId:'compile',build:'p1'});
 const req={request_id:'bad-shader',kind:'check',shader_sha:'abc',entry:{ref:'user/test@1',manifest:{id:'user/test',version:1,params:[]},shader:'bad'},document:{format:1,id:'a',revision:0,source:null,stack:[]}};
 await assert.doesNotReject(()=>service.accept({requests:[req]}));
 await service.accept({requests:[req]});
 const failed=calls.filter(c=>c.path==='/render/error?id=bad-shader');
 assert.equal(failed.length,1);assert.match(failed[0].opts.body.error,/ERROR: 0:5/);assert.equal(renders,1);
 assert.equal(calls.filter(c=>c.path.startsWith('/render/response')).length,0);
 service.dispose();
});

test('manual draft check uses the shared request and actual draft shader with supplied params',async()=>{
 const {createService}=await import('../hermes/service.mjs');const calls=[];const renders=[];
 const entry={ref:'user/manual@1',manifest:{id:'user/manual',version:1,params:[{name:'gain',type:'float',default:1}]},shader:'void main(){outColor=vec4(p_gain);}'};
 const doc={format:1,id:'manual-project',revision:0,source:null,stack:[],seed:1,timeline:null};
 const req={request_id:'manual-check',kind:'check',draft_id:'user/manual',entry,shader_sha:'a'.repeat(64),document:doc,fixture:true,params:{gain:0.5}};
 const receipt={request_id:req.request_id,path:'/plugin-data/preview.png',revision:0,metrics:{mean_luma:0.5}};
 const ctx={onDispose:()=>{},rest:async(path,opts)=>{calls.push({path,opts});if(path==='/drafts/check')return req;if(path.startsWith('/render/result'))return receipt;return {ok:true};}};
 const renderer={render:async(document,time,options)=>{renders.push({document,options});return {blob:new Blob(['compiled-preview']),metrics:{},width:1,height:1,rgba:new Uint8Array(4)};},dispose(){}};
 const service=createService(ctx,renderer,{runId:'manual',build:'p1'});
 assert.equal(typeof service.checkDraft,'function','manual check service missing');
 const result=await service.checkDraft(entry,{fixture:true,params:{gain:0.5}});
 assert.ok(result.blob instanceof Blob);
 assert.equal(renders[0].document.stack[0].tool,entry.ref);assert.equal(renders[0].document.stack[0].params.gain,0.5);
 assert.equal(renders[0].options.tools[0].shader,entry.shader);
 assert.equal(calls.find(c=>c.path==='/drafts/check').opts.body.id,'user/manual');
 service.dispose();
});

test('draft check sends editor fingerprints and displays only the durable validated entry',async()=>{
 const {createService}=await import('../hermes/service.mjs');const calls=[],seen=[];
 const a={manifest:{id:'user/snapshot',version:1,params:[]},shader:'shader A',expected_shader_sha:'a'.repeat(64),expected_manifest_sha:'c'.repeat(64)};
 const b={...a,shader:'shader B',expected_shader_sha:'b'.repeat(64),expected_manifest_sha:'d'.repeat(64)};
 const request={request_id:'snapshot-check',kind:'check',entry:b,shader_sha:b.expected_shader_sha,document:{id:'p',revision:0,source:null,stack:[]},fixture:true,params:{}};
 const receipt={request_id:request.request_id,shader_sha:b.expected_shader_sha};
 const ctx={onDispose(){},rest:async(path,opts)=>{calls.push({path,opts});if(path==='/drafts/check')return request;if(path.startsWith('/render/result'))return receipt;return {ok:true};}};
 const renderer={dispose(){},render:async(doc,time,options)=>{seen.push(options.toolOverride.shader);return {blob:new Blob([options.toolOverride.shader]),width:1,height:1,metrics:{}};}};
 const service=createService(ctx,renderer,{runId:'identity',build:'test'});
 const result=await service.checkDraft(a,{fixture:true});
 assert.deepEqual(seen,['shader B','shader B']);
 assert.deepEqual(result.request,request);assert.deepEqual(result.entry,b);
 const body=calls.find(c=>c.path==='/drafts/check').opts.body;
 assert.equal(body.expected_shader_sha,a.expected_shader_sha);assert.equal(body.expected_manifest_sha,a.expected_manifest_sha);
 assert.equal(await result.frame.blob.text(),'shader B');assert.deepEqual(result.check,receipt);service.dispose();
});

test('library export uses full-resolution renderer request and returns backend receipt',async()=>{
 const {createService}=await import('../hermes/service.mjs');const calls=[];let kind;
 const doc={format:1,id:'export-project',revision:3,stack:[],source:null,seed:1,timeline:null};
 const req={request_id:'export-id',kind:'export',document:doc};
 const receipt={request_id:req.request_id,path:'/plugin-data/exports/frame.png',width:100,height:200,revision:3};
 const ctx={onDispose:()=>{},rest:async(path,opts)=>{calls.push({path,opts});if(path==='/render/request')return req;if(path.startsWith('/render/result'))return receipt;return {ok:true};}};
 const renderer={render:async(doc,time,options)=>{kind=options.kind;return {blob:new Blob(['PNG']),width:100,height:200,metrics:{}};},dispose(){}};
 const service=createService(ctx,renderer,{runId:'export',build:'p1'});
 assert.equal(typeof service.saveLibrary,'function','library export service missing');
 assert.deepEqual(await service.saveLibrary(doc),receipt);assert.equal(kind,'export');
 assert.equal(calls.find(c=>c.path==='/render/request').opts.body.kind,'export');
 service.dispose();
});

test('diagnostics persist the supplied actual runner output with build provenance',async()=>{
 const {createService}=await import('../hermes/service.mjs');const calls=[];
 const report={pass:false,checks:[{tool:'unit-wiring-fixture',pass:false,error:'expected fixture failure'}]};
 const renderer={dispose(){}};
 const ctx={onDispose:()=>{},rest:async(path,opts)=>{calls.push({path,opts});return path==='/catalog'?{tools:[]}:opts.body;}};
 const service=createService(ctx,renderer,{runId:'diagnostic-run',build:'p1',diagnosticsRunner:async(r,tools)=>{assert.equal(r,renderer);assert.deepEqual(tools,[]);return report;}});
 assert.equal(typeof service.diagnostics,'function','diagnostic service missing');
 const result=await service.diagnostics();assert.equal(result.pass,false);
 const stored=calls.find(c=>c.path==='/diagnostics').opts.body;
 assert.equal(stored.pass,false);assert.equal(stored.build,'p1');assert.equal(stored.run_id,'diagnostic-run');
 service.dispose();
});

test('dispose closes a bitmap decoded after unload without render or post',async()=>{
 const {createService}=await import('../hermes/service.mjs');const data=Buffer.from('deferred-decode-source'),sha=createHash('sha256').update(data).digest('hex');
 let resolveDecode,started;const decoding=new Promise(resolve=>started=resolve);let closed=0,renders=0;const calls=[];
 const original=globalThis.createImageBitmap;
 globalThis.createImageBitmap=()=>{started();return new Promise(resolve=>resolveDecode=resolve);};
 const ctx={onDispose(){},rest:async(path,opts)=>{calls.push({path,opts});return {offset:0,total:data.length,bytes:data.length,mime:'image/png',base64:data.toString('base64')};}};
 const service=createService(ctx,{maxTextureSize:4096,dispose(){},render:async()=>{renders++;return {};}},{runId:'decode',build:'test'});
 try {
  const pending=service.renderProject({id:'decode',revision:0,stack:[],source:{asset:'assets/'+sha+'.png'}});
  await decoding;service.dispose();resolveDecode({width:1,height:1,close(){closed++;}});
  await assert.rejects(pending,{name:'AbortError'});assert.equal(closed,1);assert.equal(renders,0);
  assert.equal(calls.filter(c=>c.opts?.method==='POST').length,0);
 }finally{service.dispose();globalThis.createImageBitmap=original;}
});

test('page preview proactively uploads ready PNG while comparison never changes cache',async()=>{
 const {createService}=await import('../hermes/service.mjs');const calls=[];
 const ctx={onDispose:()=>{},rest:async(path,opts)=>{calls.push({path,opts});return {ok:true};}};
 const renderer={render:async()=>({blob:new Blob(['encoded-frame']),width:2,height:1,metrics:{mean_luma:0.4}}),dispose(){}};
 const service=createService(ctx,renderer,{runId:'proactive',build:'p1'});
 const doc={format:1,id:'proactive-project',revision:5,source:null,stack:[]};
 await service.renderProject(doc);await service.renderProject({...doc,stack:[]},{comparison:true});
 const cached=calls.filter(c=>c.path.startsWith('/preview/cache?'));
 assert.equal(cached.length,1,'ready page frame must update cached preview exactly once');
 const meta=JSON.parse(new URLSearchParams(cached[0].path.split('?')[1]).get('meta'));
 assert.equal(meta.project_id,doc.id);assert.equal(meta.revision,5);assert.equal(meta.metrics.mean_luma,0.4);
 service.dispose();
});
