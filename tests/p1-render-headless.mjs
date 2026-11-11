// Real Chromium/SwiftShader integration tests; no Hermes runtime.
import {createServer} from 'node:http';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import('/home/destino/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
const root=resolve(new URL('..',import.meta.url).pathname);
const tools=[];try{for(const name of await readdir(resolve(root,'tools/builtin'))){const p=resolve(root,'tools/builtin',name);const manifest=JSON.parse(await readFile(p+'/manifest.json','utf8'));tools.push({manifest,shader:await readFile(p+'/shader.frag','utf8'),ref:`${manifest.id}@${manifest.version}`,status:'builtin'});}}catch{}
const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('P1 renderer harness');return;}const path=resolve(root,'.'+new URL(req.url,'http://local').pathname);if(!path.startsWith(root+'/'))throw Error('path');res.setHeader('Content-Type',extname(path)==='.mjs'?'text/javascript':'text/plain');res.end(await readFile(path));}catch{res.writeHead(404);res.end('missing');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
const result=await page.evaluate(async({tools,stage})=>{
 const {createRenderer}=await import('/core/renderer.mjs');const canvas=document.createElement('canvas');const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true,alpha:true,premultipliedAlpha:false,antialias:false});const counts={};
 for(const kind of ['Texture','Framebuffer','Program','Shader','VertexArray'])for(const action of ['create','delete']){const key=action+kind,original=gl[key].bind(gl);counts[key]=0;gl[key]=(...args)=>{counts[key]++;return original(...args);};}
 const r=createRenderer(canvas);const checks=[];
 const ok=(name,condition,detail)=>{checks.push({name,pass:!!condition,detail});};
 const near=(a,b,t=1)=>a.length===b.length&&a.every((v,i)=>Math.abs(v-b[i])<=t);
 const doc={format:1,source:{w:2,h:2},seed:9,stack:[],timeline:null};
 const source={width:2,height:2,rgba:new Uint8Array([255,0,0,128,0,255,0,255,0,0,255,0,128,64,32,200])};
 const f=await r.render(doc,0,{source,tools});ok('typed source retains top-down orientation and straight alpha',near([...f.rgba],[...source.rgba]),[...f.rgba]);
 ok('render metrics compare sampled source',f.metrics.difference_source===0&&f.metrics.difference_previous===null,f.metrics);
 const prior=await r.render(doc,0,{source,tools,previous:f});ok('render metrics accept previous frame',prior.metrics.difference_previous===0,prior.metrics);
 const bitmap=await createImageBitmap(f.blob);const decoded=document.createElement('canvas');decoded.width=2;decoded.height=2;decoded.getContext('2d').drawImage(bitmap,0,0);const decodedRGBA=decoded.getContext('2d').getImageData(0,0,2,2).data;ok('PNG top-down orientation and alpha',near([...decodedRGBA.slice(0,8)],[...source.rgba.slice(0,8)],2),[...decodedRGBA]);
 const dom=await r.render(doc,0,{source:decoded});ok('CanvasImageSource orientation and straight alpha',near([...dom.rgba],[...decodedRGBA],2),[...dom.rgba]);bitmap.close();
 if(stage==='source'){r.dispose();return {checks};}
 const entry={manifest:{format:1,id:'test/uniforms',version:1,params:[{name:'gain',type:'float',default:0.5},{name:'steps',type:'int',default:2},{name:'on',type:'bool',default:true},{name:'color',type:'color',default:'#808080'},{name:'mode',type:'enum',options:['first','second'],default:'second'}]},shader:'void main(){outColor=vec4(p_gain,float(p_steps)/4.0,p_on?p_color.r:0.0,p_mode==1?1.0:0.0);}',ref:'test/uniforms@1'};
 const single={width:1,height:1,rgba:new Uint8Array([64,128,192,128])};const d={...doc,source:{w:1,h:1},stack:[{tool:entry.ref,params:{},opacity:1,enabled:true,blend:'normal'}]};
 const uf=await r.render(d,0,{source:single,tools:[entry]});ok('five uniform types with linear color conversion',near([...uf.rgba],[128,128,55,255]),[...uf.rgba]);
 const override=await r.render({...d,stack:[{...d.stack[0],params:{gain:.25,steps:3,on:false,mode:'first'}}]},0,{source:single,tools:[entry],previous:uf});ok('typed uniforms honor explicit overrides',near([...override.rgba],[64,191,0,0]),[...override.rgba]);
 const difference=(a,b)=>a.slice(0,3).reduce((sum,v,i)=>sum+Math.abs(v-b[i]),0)/(3*255);ok('nonzero frame differences are actually measured',Math.abs(uf.metrics.difference_source-difference([...uf.rgba],[...single.rgba]))<1e-12&&Math.abs(override.metrics.difference_previous-difference([...override.rgba],[...uf.rgba]))<1e-12,{source:uf.metrics.difference_source,previous:override.metrics.difference_previous});
 const check=await r.checkTool(entry,{source:single});ok('valid checkTool compiles and renders actual source',near([...check.rgba],[128,128,55,255]),[...check.rgba]);
 for(const blend of ['normal','multiply','screen','overlay']){const b=[64,128,192].map(v=>v/255),s=[128,128,55].map(v=>v/255);const expected=b.map((v,i)=>{let q=s[i];if(blend==='multiply')q=v*q;if(blend==='screen')q=1-(1-v)*(1-q);if(blend==='overlay')q=v<0.5?2*v*q:1-2*(1-v)*(1-q);return Math.round(255*(v*0.75+q*0.25));});expected.push(160);const q=await r.render({...d,stack:[{...d.stack[0],blend,opacity:0.25}]},0,{source:single,tools:[entry]});ok('straight-alpha '+blend+' blend opacity',near([...q.rgba],expected,2),{actual:[...q.rgba],expected});}
 const identity={...entry,manifest:{...entry.manifest,id:'test/add',params:[]},ref:'test/add@1',shader:'void main(){outColor=texture(u_input,v_uv)+vec4(0.1,0.0,0.0,0.0);}'};
 const stacked=await r.render({...d,stack:[{tool:identity.ref},{tool:identity.ref},{tool:identity.ref,enabled:false}]},0,{source:single,tools:[identity]});ok('pingpong ordered stack skips disabled',near([...stacked.rgba],[116,128,192,128],2),[...stacked.rgba]);
 const changed={...identity,shader:'void main(){outColor=vec4(0,1,0,1);}'};const cached=await r.render({...d,stack:[{tool:identity.ref}]},0,{source:single,tools:[changed]});ok('cache invalidates on shader contents',near([...cached.rgba],[0,255,0,255]),[...cached.rgba]);
 let compileError='';try{await r.checkTool({...changed,shader:'void main(){ BROKEN; }'});}catch(e){compileError=String(e);}ok('checkTool readable GLSL error',/GLSL.*(ERROR|error)/s.test(compileError),compileError);
 let timeError='';try{await r.render(doc,1);}catch(e){timeError=String(e);}ok('nonstatic time rejected',/time/.test(timeError));
 let exportError='';try{await r.render({...doc,source:{w:4097,h:1}},0,{kind:'export'});}catch(e){exportError=String(e);}ok('oversize export rejected',/4096|limit/.test(exportError));
 const sized=await r.render({...doc,source:{w:1800,h:900}},0,{max_size:100});ok('preview aspect and max_size',sized.width===100&&sized.height===50);
 const capped=await r.render({...doc,source:{w:1601,h:1}},0,{max_size:9000});ok('preview hard cap is 1600px',capped.width===1600&&capped.height===1);
 const exported=await r.render({...doc,source:{w:4096,h:1}},0,{kind:'export'});ok('export keeps 4096px full resolution',exported.width===4096&&exported.height===1);
 const cachedBefore=counts.createProgram;await r.render({...d,stack:[{tool:identity.ref}]},0,{source:single,tools:[changed]});ok('cache reuses exact id version and shader',counts.createProgram===cachedBefore,{before:cachedBefore,after:counts.createProgram});
 const versioned={...changed,manifest:{...changed.manifest,version:2},ref:'test/add@2'};await r.render({...d,stack:[{tool:versioned.ref}]},0,{source:single,tools:[versioned]});ok('cache keys include version',counts.createProgram===cachedBefore+1);
 const reidentified={...changed,manifest:{...changed.manifest,id:'test/other'},ref:'test/other@1'};await r.render({...d,stack:[{tool:reidentified.ref}]},0,{source:single,tools:[reidentified]});ok('cache keys include id',counts.createProgram===cachedBefore+2);
 for(const sourceDoc of [{w:0,h:1},{w:1,h:0},{w:NaN,h:1},{w:1.5,h:1}]){let error='';try{await r.render({...doc,source:sourceDoc});}catch(e){error=String(e);}ok('invalid explicit dimensions rejected '+String(sourceDoc.w)+'x'+String(sourceDoc.h),/dimensions/.test(error),error);}
 let missingAsset='';try{await r.render({...doc,source:{w:2,h:2,asset:'assets/missing.png'}});}catch(e){missingAsset=String(e);}ok('missing imported source never replaced by fixture',/source/.test(missingAsset),missingAsset);
 let failedParam='';try{await r.render({...d,stack:[{...d.stack[0],params:{gain:NaN}}]},0,{source:single,tools:[entry]});}catch(e){failedParam=String(e);}ok('bad uniform rejects and frees transient GPU resources',/parameter/.test(failedParam),failedParam);
 ok('all render textures and FBOs freed',counts.createTexture===counts.deleteTexture&&counts.createFramebuffer===counts.deleteFramebuffer,{...counts});
 r.dispose();r.dispose();ok('dispose releases programs shaders and VAO exactly once',['Program','Shader','VertexArray','Texture','Framebuffer'].every(k=>counts['create'+k]===counts['delete'+k]),{...counts});let disposedError='';try{await r.render(doc);}catch(e){disposedError=String(e);}ok('disposed render rejected',/disposed/.test(disposedError));return {checks};
},{tools,stage:process.env.P1_STAGE||'stack'});
result.browser_version=await browser.version();result.evidence_scope="standalone Chromium software-WebGL2; no Hermes runtime";
console.log(JSON.stringify(result,null,2));if(process.env.P1_EVIDENCE)await writeFile(resolve(root,process.env.P1_EVIDENCE),JSON.stringify(result,null,2)+'\n');assert.ok(result.checks.every(c=>c.pass),'P1 renderer check failed');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
