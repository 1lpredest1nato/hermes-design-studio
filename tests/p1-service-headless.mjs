// Real service/core and real HTTP backend. SDK IPC is NOT tested here.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
const {chromium}=await import('/home/destino/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
const base=process.argv[2];
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
try {
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(String(e)));
 await page.goto(base+'/code/tests/p0-core.test.mjs');
 const result=await page.evaluate(async()=>{
  const {createRenderer}=await import('/code/core/renderer.mjs');
  const {runDiagnostics}=await import('/code/core/diagnostics.mjs');
  const {createService}=await import('/code/hermes/service.mjs');
  const {uploadChunks}=await import('/code/hermes/upload.mjs');
  const calls=[];let dispose;
  async function rest(path,options={}) {
   let body,headers={};
   if(options.upload){body=new FormData();body.append('file',new Blob([options.upload.bytes],{type:options.upload.contentType}),options.upload.filename);}
   else if(options.body!==undefined){headers['content-type']='application/json';body=JSON.stringify(options.body);}
   const response=await fetch(path,{method:options.method||'GET',headers,body});
   const json=await response.json();calls.push({path,status:response.status});
   if(!response.ok){const error=new Error(JSON.stringify(json));error.status=response.status;error.document=json.document;throw error;}
   return json;
  }
  const renderer=createRenderer(document.createElement('canvas'));
  const service=createService({rest,onDispose:fn=>dispose=fn},renderer,{runId:crypto.randomUUID(),build:'P1-secondary-full-service',diagnosticsRunner:runDiagnostics});
  let doc=(await rest('/project/new',{method:'POST',body:{}})).document;
  const source=document.createElement('canvas');source.width=64;source.height=48;const cx=source.getContext('2d');
  const pixels=cx.createImageData(64,48);for(let i=0;i<pixels.data.length;i+=4){const n=i/4;pixels.data.set([n%256,(n*7)%256,(n*13)%256,255],i);}cx.putImageData(pixels,0,0);
  const png=await new Promise(resolve=>source.toBlob(resolve,'image/png'));
  const upload=await uploadChunks(png,{rest,signal:service.signal});
  doc=(await rest('/commands',{method:'POST',body:{project_id:doc.id,base_revision:doc.revision,commands:[{type:'set_source',source:{asset:upload.receipt.asset,w:64,h:48}},{type:'add_node',uid:'pixels',tool:'builtin/pixelate@1',params:{size:4}}]}})).document;
  const first=await service.renderProject(doc);
  if(!Number.isFinite(first.metrics.difference_source)||first.metrics.difference_source<=0)throw new Error('source difference not measured');
  doc=(await rest('/commands',{method:'POST',body:{project_id:doc.id,base_revision:doc.revision,commands:[{type:'add_node',tool:'builtin/levels@1',params:{brightness:0.2}}]}})).document;
  const frame=await service.renderProject(doc);
  if(!Number.isFinite(frame.metrics.difference_previous)||frame.metrics.difference_previous<=0)throw new Error('previous revision difference not measured');
  const output=await service.saveLibrary(doc);
  const draft=await rest('/drafts',{method:'POST',body:{name:'Integration inversion',description:'automated isolated test fixture, not human approval evidence',params:[],shader:'void main(){vec4 c=texture(u_input,v_uv);outColor=vec4(1.0-c.rgb,c.a);}'}});
  const current=await service.checkDraft(draft,{fixture:false});const fixture=await service.checkDraft(draft,{fixture:true});
  if(!current.blob||!fixture.blob)throw new Error('draft previews missing');
  const broken=await rest('/drafts',{method:'POST',body:{name:'Integration broken',description:'compile failure fixture',params:[],shader:'void main(){outColor=BROKEN_TOKEN;}'}});
  let compilationError='';try{await service.checkDraft(broken,{fixture:true});}catch(e){compilationError=String(e);}
  if(!compilationError.includes('BROKEN_TOKEN'))throw new Error('GLSL compile failure was not retained: '+compilationError);
  const diagnostics=await service.diagnostics();if(!diagnostics.pass)throw new Error('diagnostics failed '+JSON.stringify(diagnostics));
  const stored=await rest('/diagnostics');if(!stored.pass||stored.checks.length!==7)throw new Error('diagnostics readback failed');
  const commandlog=doc.last_command_id;
  dispose();
  return {pass:true,evidence_scope:'isolated real HTTP Application + browser service/core; not Hermes Desktop/SDK or human-approval evidence',document:doc,command_id:commandlog,upload,metrics:frame.metrics,export:output,current_draft_preview:{width:current.width,height:current.height,metrics:current.metrics},fixture_draft_preview:{width:fixture.width,height:fixture.height},compilationError,diagnostics:{pass:diagnostics.pass,checks:diagnostics.checks.map(c=>({tool:c.tool,pass:c.pass}))},requests:calls};
 });
 result.browser_version=await browser.version();result.uncaught_errors=errors;
 await writeFile(new URL('../evidence/p1-parent-service-browser.json',import.meta.url),JSON.stringify(result,null,2)+'\n');
 assert.equal(result.pass,true);assert.deepEqual(errors,[]);
 console.log(JSON.stringify(result,null,2));
} finally {await browser.close();}
