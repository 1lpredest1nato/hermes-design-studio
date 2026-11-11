// Framework-free UI transport and manifest adapters. Backend owns all document edits.
export function paramValue(param, raw) {
 if(param.type==='bool')return Boolean(raw);
 if(param.type==='float'||param.type==='int') {
  if(raw===''||!Number.isFinite(Number(raw)))throw new Error('Enter a finite number');
  return Number(raw);
 }
 return String(raw);
}
function assertLive(signal){if(signal.aborted)throw new DOMException('Import cancelled','AbortError');}
/** Decode first; normalize to PNG for the gateway's content-addressed asset store. */
export async function importImage(file,{signal,maxTextureSize,decode,show,encode,upload,send}) {
 assertLive(signal);let bitmap;
 try {
  bitmap=await decode(file);assertLive(signal);
  if(Math.max(bitmap.width,bitmap.height)>maxTextureSize)throw new Error(`Image exceeds GPU texture limit ${maxTextureSize}px (${bitmap.width} × ${bitmap.height}). Resize the image before importing.`);
  show({blob:file,width:bitmap.width,height:bitmap.height,local:true});
  const png=await encode(bitmap);assertLive(signal);
  const result=await upload(png);assertLive(signal);
  const asset=result.receipt?.asset;
  if(typeof asset!=='string')throw new Error('Upload completed without an asset receipt');
  await send([{type:'set_source',source:{asset,w:bitmap.width,h:bitmap.height}}]);assertLive(signal);
  return result;
 }finally {bitmap?.close();}
}

export function paramDefaults(params=[]) {return Object.fromEntries(params.map(p=>[p.name,p.default]));}

/** Serialize transport only: never execute or replay a document command in JS. */
export function createCommandChannel({rest,getDocument,onDocument,refresh,onConflict=()=>{},
 now=()=>Date.now(),wait=ms=>new Promise(r=>setTimeout(r,ms))}) {
 let closed=false,running=false,last=-Infinity;
 const pending=[];
 async function drain(initialSnapshot) {
  if(running)return;running=true;
  while(pending.length&&!closed) {
   const job=pending.shift();
   try {
    const pause=Math.max(0,1000/15-(now()-last));if(pause)await wait(pause);
    if(closed)throw new Error('Command channel closed');
    // Immediate jobs reuse their enqueue snapshot; waiting jobs must recheck identity.
    const snapshot=!pause&&initialSnapshot?initialSnapshot:getDocument();initialSnapshot=undefined;
    if(snapshot.id!==job.projectId)throw Object.assign(new Error('HTTP 409 project identity conflict'),{status:409});
    const body={...job.body,project_id:job.projectId,base_revision:snapshot.revision};last=now();
    const result=await rest(job.path,{method:'POST',body});
    if(closed)throw new Error('Command channel closed');
    onDocument(result.document);job.listeners.forEach(p=>p.resolve(result));
   }catch(error) {
    if(!closed&&(error.status===409||/409|revision.*conflict/i.test(String(error)))) {
     try {const state=error.document?{document:error.document}:await refresh();if(!closed)onDocument(state.document);}catch{}
     if(!closed)onConflict();
     pending.splice(0).forEach(j=>j.listeners.forEach(p=>p.reject(error)));
    }
    job.listeners.forEach(p=>p.reject(error));
   }
  }
  running=false;
 }
 function enqueue(path,body,gesture) {
  if(closed)return Promise.reject(new Error('Command channel closed'));
  return new Promise((resolve,reject)=>{
   const snapshot=getDocument(),projectId=snapshot.id;
   const tail=pending.at(-1);
   if(gesture&&tail?.gesture===gesture&&tail.path===path&&tail.projectId===projectId) {
    tail.body=body;tail.listeners.push({resolve,reject});
   }else pending.push({path,body,gesture,projectId,listeners:[{resolve,reject}]});
   void drain(snapshot);
  });
 }
 return {
  send(commands,gesture_id){return enqueue('/commands',{commands,...(gesture_id?{gesture_id}:{})},gesture_id);},
  action(path,body={}){return enqueue(path,body);},
  dispose(){closed=true;pending.splice(0).forEach(j=>j.listeners.forEach(p=>p.reject(new Error('Command channel closed'))));}
 };
}
