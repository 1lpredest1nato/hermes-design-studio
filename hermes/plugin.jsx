import {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {host,useQuery,Button,ROUTES_AREA,SIDEBAR_NAV_AREA,PALETTE_AREA,TITLEBAR_AREAS} from '@hermes/plugin-sdk';
import {createRenderer} from '../core/renderer.mjs';
import {createService} from './service.mjs';
import {makeUploadProbe,uploadChunks} from './upload.mjs';
export const BUILD='design-studio-p0-20261111-detached-1';
const fixture={format:1,id:'p0',revision:0,source:null,stack:[],seed:1234,timeline:null};
const layout={padding:24,display:'grid',gap:16,color:'var(--ui-text-primary)',overflow:'auto',height:'100%',boxSizing:'border-box'};
const box={padding:16,border:'1px solid var(--ui-stroke-secondary)',borderRadius:8};

function ServiceMount({service}) {
 useQuery({queryKey:['hermes-design-studio',service.metadata().run_id,'service-poll'],
  queryFn:async()=>{
   const state=await service.rest('/state');
   await service.accept(state,'poll');
   await service.cache(state.document);
   return {revision:state.document.revision,at:Date.now()};
  },refetchInterval:2500,refetchIntervalInBackground:true,retry:1});
 // Documented permanent titlebar mount; no visual chrome and no route ownership.
 return null;
}
function RiskPage({service,diagnostics=false}) {
 const snapshot=useSyncExternalStore(service.subscribe,service.getSnapshot);
 const [image,setImage]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [progress,setProgress]=useState(null),[result,setResult]=useState(null),[save,setSave]=useState('not tested');
 const task=useRef(null),urls=useRef(new Set());
 function ownURL(blob){const url=URL.createObjectURL(blob);urls.current.add(url);return url;}
 useEffect(()=>{
  const controller=new AbortController();task.current=controller;service.page(true);
  const abort=()=>controller.abort();service.signal.addEventListener('abort',abort,{once:true});
  service.report({page:{active:true,route:diagnostics?'/design-studio/diagnostics':'/design-studio'}}).catch(()=>{});
  // Queue behind the service renderer: one GPU owner, no route-local renderer.
  service.render(fixture,0).then(frame=>{if(!controller.signal.aborted)setImage(ownURL(frame.blob));}).catch(e=>{if(!controller.signal.aborted)setError(String(e));});
  return()=>{
   controller.abort();service.signal.removeEventListener('abort',abort);service.page(false);
   for(const url of urls.current)URL.revokeObjectURL(url);urls.current.clear();
   if(!service.signal.aborted)service.report({page:{active:false}}).catch(()=>{});
  };
 },[service,diagnostics]);
 async function upload(blob,label) {
  const signal=task.current.signal;
  const uploaded=await uploadChunks(blob,{rest:service.rest,signal,onProgress:async p=>{
   if(signal.aborted)return;setProgress(p);
   await service.report({upload_probe:{label,status:'uploading',...p}});
  }});
  if(signal.aborted)return;
  const observation={...uploaded,label,status:'complete',actual_png_bytes:blob.size,at_least_20MiB:blob.size>=20*1024*1024};
  await service.report({upload_probe:observation});
  if(!signal.aborted)setResult(observation);
 }
 async function probe() {
  setBusy(true);setError('');setResult(null);
  try {const blob=await makeUploadProbe(document.createElement('canvas'),task.current.signal);await upload(blob,'generated-high-entropy-PNG');}
  catch(e){if(!task.current.signal.aborted){setError(String(e));await service.report({upload_probe:{status:'error',error:String(e),hint:'OAuth remote uploads are unsupported; use token connection.'}}).catch(()=>{});}}
  finally{if(!task.current.signal.aborted)setBusy(false);}
 }
 async function importFile(file) {
  if(!file)return;setBusy(true);setError('');
  let bitmap;
  const signal=task.current.signal;
  try{
   bitmap=await createImageBitmap(file);if(signal.aborted)return;
   if(Math.max(bitmap.width,bitmap.height)>service.renderer.maxTextureSize)throw new Error(`Image exceeds GPU texture limit ${service.renderer.maxTextureSize}px`);
   const localCanvas=document.createElement('canvas');localCanvas.width=bitmap.width;localCanvas.height=bitmap.height;
   localCanvas.getContext('2d').drawImage(bitmap,0,0);
   const localPng=await new Promise((resolve,reject)=>localCanvas.toBlob(blob=>blob?resolve(blob):reject(new Error('Imported PNG encoding failed')),'image/png'));
   if(signal.aborted)return;setImage(ownURL(localPng));
   await upload(file,'user-file-on-this-computer');
   if(!signal.aborted)await service.report({import:{name:file.name,width:bitmap.width,height:bitmap.height,bytes:file.size,stored:true,applied_to_project:false}});
  }catch(e){if(!signal.aborted)setError(String(e)+' Upload uses this computer; server-path import is a separate agent action. OAuth remote upload requires token connection.');}
  finally{bitmap?.close();if(!signal.aborted)setBusy(false);}
 }
 function saveClicked(){setSave('clicked — native dialog awaiting your confirmation');service.report({save_as:{clicked:true,dialog_verified:false,method:'plugin-owned-anchor-download'}}).catch(()=>{});}
 async function verifyDialog(){setSave('dialog confirmed by user');await service.report({save_as:{clicked:true,dialog_verified:true,evidence:'explicit-user-confirmation'}});}
 return <main style={layout}>
  <header><h1>Hermes Design Studio · P0 {diagnostics?'diagnostics':'risk probe'}</h1>
   <p>Detached WebGL2 service, chunk upload and client-side Save as. P0 renders a fixed gradient, not a shader stack.</p>
   <small>Build {BUILD} · run {snapshot.run_id}</small></header>
  <section style={box}><h2>Service proof</h2>
   <p>Navigate to chat, then request preview/export in a fresh agent session. This page is not the renderer lifetime.</p>
   <pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(snapshot,null,2)}</pre>
   <p>page_active must be false in the resulting service report. A ready label is not a pass.</p>
   <Button onClick={()=>host.navigate('/design-studio/diagnostics')}>Diagnostics</Button>{' '}
   <Button onClick={()=>host.navigate('/')}>Leave page for chat</Button>
  </section>
  <section style={box} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();if(!busy)importFile(e.dataTransfer.files[0]);}}>
   <h2>Image on this computer</h2>
   <label>Upload image <input type="file" accept="image/*" disabled={busy} onChange={e=>importFile(e.target.files[0])}/></label>
   <p>Drop an image here. P0 decodes and stores chunks; importing does not yet change the project.</p>
   {image&&<img src={image} alt="P0 fixture or local imported image" style={{maxWidth:'100%',maxHeight:280,objectFit:'contain'}}/>}
   <p>{image&&<a href={image} download="design-studio-p0.png" onClick={saveClicked}>Save as… (on this computer)</a>}</p>
   <p>{save}</p><Button onClick={verifyDialog} disabled={!save.startsWith('clicked')}>I saw the native Save dialog</Button>
   <p>No automatic download clicks. Backend export paths are on the gateway, not necessarily this computer.</p>
  </section>
  <section style={box}><h2>≥20 MiB actual PNG upload probe</h2>
   <Button disabled={busy} onClick={probe}>{busy?'Working…':'Generate PNG and upload 4 MiB chunks'}</Button>
   {progress&&<p>{progress.index+1}/{progress.total} receipts · {progress.bytes_received}/{progress.bytes_total} bytes</p>}
   {result&&<pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(result,null,2)}</pre>}
   <p>Success requires the assembled backend SHA-256 to equal the browser digest. No generated pass before receipts.</p>
  </section>
  {error&&<section role="alert" style={box}><h2>Observed error</h2><pre style={{whiteSpace:'pre-wrap'}}>{error}</pre></section>}
 </main>;
}
export default {id:'hermes-design-studio',name:'Hermes Design Studio',register(ctx){
 const canvas=document.createElement('canvas');
 const renderer=createRenderer(canvas);
 const service=createService(ctx,renderer,{runId:crypto.randomUUID(),build:BUILD});
 ctx.register({id:'service',area:TITLEBAR_AREAS.right,render:()=> <ServiceMount service={service}/>});
 ctx.register({id:'page',area:ROUTES_AREA,data:{path:'/design-studio'},render:()=> <RiskPage service={service}/>});
 ctx.register({id:'diagnostics',area:ROUTES_AREA,data:{path:'/design-studio/diagnostics'},render:()=> <RiskPage service={service} diagnostics/>});
 ctx.register({id:'nav',area:SIDEBAR_NAV_AREA,data:{path:'/design-studio',label:'Design Studio',codicon:'paintcan'}});
 ctx.register({id:'command',area:PALETTE_AREA,data:{id:'design-studio.open',label:'Design Studio: open P0 risks',keywords:['design','studio'],run:()=>host.navigate('/design-studio')}});
 ctx.onEvent('*',event=>{
  if(!event.type?.startsWith('plugin.hermes-design-studio.'))return;
  service.rest('/state').then(async state=>{await service.accept(state,'event');await service.cache(state.document);}).catch(()=>{});
 });
 service.report({runtime:{user_agent:navigator.userAgent,renderer:renderer.info,max_texture_size:renderer.maxTextureSize},service:{status:'registered',page_active:false,detached_canvas:!canvas.isConnected}}).catch(()=>{});
}};
