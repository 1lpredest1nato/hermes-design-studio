// SDK transport has no AbortSignal option. Already-issued IPC cannot be recalled;
// all continuations and subsequent submissions are gated by plugin disposal.
import {loadAsset} from './assets.mjs';
export function createService(ctx, renderer, {runId, build, diagnosticsRunner}) {
  const controller = new AbortController();
  const handled = new Set(), inflight = new Set();
  let pageCount = 0, cacheRevision = null;
  let tail = Promise.resolve();
  let snapshot = {run_id:runId,build,detached_canvas:true,page_active:false,status:'ready'};
  const listeners = new Set();
  const assets = new Map();
  const frames = new Map();
  const alive = () => { if(controller.signal.aborted) throw new DOMException('Plugin unloaded','AbortError'); };
  const publish = change => { snapshot = {...snapshot,...change}; for(const fn of listeners) fn(); };
  async function rest(path,opts) { alive(); const value = await ctx.rest(path,opts); alive(); return value; }
  function metadata(extra={}) { return {run_id:runId,build,page_active:pageCount>0,detached_canvas:true,at:new Date().toISOString(),...extra}; }
  async function report(fields) {
    const update={...metadata(),...fields};
    return rest('/report',{method:'POST',body:{...update,runs:{[runId]:update}}});
  }
  async function renderOne(request,via,cache=false) {
    alive();
    const doc = request.document;
    const options={kind:request.kind==='check'?'preview':(request.kind || 'preview'),max_size:request.max_size,
      ...(request.kind==='check'?{toolOverride:request.entry,params:request.params,fixture:request.fixture!==false,comparison:true}: {})};
    const frame = await projectFrame(doc,options); alive();
    return persistFrame(request,frame,via,cache);
  }
  async function persistFrame(request,frame,via,cache) {
    const doc=request.document;
    const bytes = await frame.blob.arrayBuffer(); alive();
    const meta = metadata({request_id:request.request_id,kind:request.kind || 'preview',revision:doc.revision,project_id:doc.id,via,
      width:frame.width,height:frame.height,metrics:frame.metrics,fixture:(!doc.source||frame.fixture===true||(request.kind==='check'&&request.fixture!==false)),u_time:0,
      ...(request.kind==='check'?{shader_sha:request.shader_sha}: {})});
    const path = cache ? `/preview/cache?revision=${doc.revision}&meta=${encodeURIComponent(JSON.stringify(meta))}`
      : `/render/response?id=${encodeURIComponent(request.request_id)}&meta=${encodeURIComponent(JSON.stringify(meta))}`;
    const receipt = await rest(path,{method:'POST',upload:{filename:'studio-preview.png',contentType:'image/png',bytes},timeoutMs:15000});
    const observation={...meta,request_id:request.request_id || null,receipt,png_bytes:bytes.byteLength};
    await report({service:observation,renders:{[request.request_id || `cache-${doc.revision}`]:observation}});
    publish({last:meta,status:'rendered'});
    return receipt;
  }
  function enqueue(fn) { const result = tail.then(() => {alive();return fn();}); tail = result.catch(() => {}); return result; }
  async function projectFrame(document, options={}) {
    alive();
    if(options.toolOverride) {
      const entry=options.toolOverride,manifest=entry.manifest;
      const ref=entry.ref || `${manifest.id}@${manifest.version}`;
      document={...document,source:options.fixture?null:document.source,
        stack:[{uid:'draft-preview',tool:ref,enabled:true,opacity:1,blend:'normal',
          params:{...Object.fromEntries((manifest.params||[]).map(p=>[p.name,p.default])),...(options.params||{})}}]};
    }
    const tools = options.toolOverride?[options.toolOverride]:(options.tools || (document.stack?.length ? (await rest('/catalog')).tools : []));
    alive();
    let source = options.source;
    if(!source && document.source?.asset) {
      const key=document.source.asset;
      if(!assets.has(key)) {
        const blob=await loadAsset(rest,key,controller.signal);alive();
        const bitmap=await createImageBitmap(blob);
        if(controller.signal.aborted){bitmap.close();alive();}
        if(Math.max(bitmap.width,bitmap.height)>renderer.maxTextureSize) {bitmap.close();throw new Error('Source exceeds GPU texture limit');}
        assets.set(key,bitmap);
        if(assets.size>2) {const oldest=assets.keys().next().value;assets.get(oldest).close();assets.delete(oldest);}
      }
      source=assets.get(key);
    }
    const track=!options.comparison&&!options.toolOverride&&options.kind!=='export';
    const old=frames.get(document.id);
    const previous=options.previous || (track&&old ? (old.revision===document.revision?old.prior:old.frame) : undefined);
    const frame=await renderer.render(document,0,{...options,tools,source,previous});alive();
    if(track&&frame.rgba instanceof Uint8Array) {
      if(!old||old.revision!==document.revision)frames.set(document.id,{revision:document.revision,prior:old?.frame,frame:{rgba:frame.rgba,width:frame.width,height:frame.height}});
      if(frames.size>2)frames.delete(frames.keys().next().value);
    }
    return frame;
  }
  async function accept(data,via='poll') {
    if(controller.signal.aborted) return;
    const work = [];
    for(const request of data.requests || data.pending || []) {
      if(handled.has(request.request_id) || inflight.has(request.request_id)) continue;
      inflight.add(request.request_id);
      work.push(enqueue(() => renderOne(request,via)).then(() => handled.add(request.request_id))
        .catch(async error => {
          if(controller.signal.aborted)return;
          await rest(`/render/error?id=${encodeURIComponent(request.request_id)}`,{method:'POST',body:{error:String(error),shader_sha:request.shader_sha}});
          handled.add(request.request_id);
          publish({status:'error',error:String(error)});
          await report({render_errors:{[request.request_id]:metadata({error:String(error),shader_sha:request.shader_sha})}});
        })
        .finally(() => inflight.delete(request.request_id)));
    }
    await Promise.all(work);
  }
  function cache(document) {
    const key=`${document.id}:${document.revision}`;
    if(controller.signal.aborted || cacheRevision===key) return Promise.resolve();
    cacheRevision=key;
    return enqueue(() => renderOne({document,kind:'preview'},'poll',true)).catch(error => {
      cacheRevision=null; if(!controller.signal.aborted) {publish({status:'error',error:String(error)}); throw error;}
    });
  }
  async function waitResult(id) {
    const deadline=Date.now()+10000;
    do {
      const result=await rest(`/render/result?id=${encodeURIComponent(id)}`);
      if(!result.pending) {if(result.error)throw new Error(result.error);return result;}
      await new Promise((resolve,reject)=>{
        const cancel=()=>{clearTimeout(timer);reject(new DOMException('Plugin unloaded','AbortError'));};
        const timer=setTimeout(()=>{controller.signal.removeEventListener('abort',cancel);resolve();},100);
        controller.signal.addEventListener('abort',cancel,{once:true});
      });
      alive();
    }while(Date.now()<deadline);
    throw new Error('Renderer response timed out');
  }
  async function checkDraft(entry,options={}) {
    const request=await rest('/drafts/check',{method:'POST',body:{id:entry.manifest.id,expected_shader_sha:entry.expected_shader_sha,expected_manifest_sha:entry.expected_manifest_sha,fixture:options.fixture!==false,params:options.params||{}}});
    await accept({requests:[request]},'manual');
    const check=await waitResult(request.request_id);
    const frame=await enqueue(()=>projectFrame(request.document,{toolOverride:request.entry,params:request.params,fixture:request.fixture!==false,kind:'preview',comparison:true}));
    return {...frame,frame,check,request,entry:request.entry};
  }
  async function saveLibrary(document) {
    const request=await rest('/render/request',{method:'POST',body:{kind:'export',base_revision:document.revision,project_id:document.id}});
    if(request.document.id!==document.id||request.document.revision!==document.revision)throw new Error('Project changed before export; refresh and retry');
    await accept({requests:[request]},'manual');
    return waitResult(request.request_id);
  }
  async function diagnostics() {
    if(!diagnosticsRunner)throw new Error('Diagnostic runner unavailable');
    const catalog=await rest('/catalog');
    return enqueue(async()=>{
      const result=await diagnosticsRunner(renderer,catalog.tools);alive();
      const stamped={...result,...metadata()};
      await rest('/diagnostics',{method:'POST',body:stamped});
      return stamped;
    });
  }
  function dispose() { if(controller.signal.aborted) return; controller.abort(); renderer.dispose(); for(const bitmap of assets.values())bitmap.close();assets.clear();frames.clear();listeners.clear(); }
  ctx.onDispose(dispose);
  return {accept,cache,report,rest,renderer,signal:controller.signal,dispose,
    render:(document,time=0,options)=>enqueue(()=>renderer.render(document,time,options)),
    renderProject:(document,options={})=>enqueue(async()=>{
      const frame=await projectFrame(document,options);
      if((options.kind||'preview')==='preview'&&!options.comparison&&!options.toolOverride) {
        await persistFrame({document,kind:'preview'},frame,'ui',true);
        cacheRevision=`${document.id}:${document.revision}`;
      }
      return frame;
    }),
    checkDraft,
    saveLibrary,
    diagnostics,
    getState:()=>rest('/state'),
    getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    page(active) {pageCount=Math.max(0,pageCount+(active?1:-1));publish({page_active:pageCount>0});},metadata};
}
