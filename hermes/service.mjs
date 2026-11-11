// SDK transport has no AbortSignal option. Already-issued IPC cannot be recalled;
// all continuations and subsequent submissions are gated by plugin disposal.
export function createService(ctx, renderer, {runId, build}) {
  const controller = new AbortController();
  const handled = new Set(), inflight = new Set();
  let pageCount = 0, cacheRevision = null;
  let tail = Promise.resolve();
  let snapshot = {run_id:runId,build,detached_canvas:true,page_active:false,status:'ready'};
  const listeners = new Set();
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
    const frame = await renderer.render(doc,0,{kind:request.kind || 'preview'}); alive();
    const bytes = await frame.blob.arrayBuffer(); alive();
    const meta = metadata({request_id:request.request_id,kind:request.kind || 'preview',revision:doc.revision,via,
      width:frame.width,height:frame.height,metrics:frame.metrics,fixture:true,u_time:0});
    const path = cache ? `/preview/cache?revision=${doc.revision}&meta=${encodeURIComponent(JSON.stringify(meta))}`
      : `/render/response?id=${encodeURIComponent(request.request_id)}&meta=${encodeURIComponent(JSON.stringify(meta))}`;
    const receipt = await rest(path,{method:'POST',upload:{filename:'p0-preview.png',contentType:'image/png',bytes},timeoutMs:15000});
    const observation={...meta,request_id:request.request_id || null,receipt,png_bytes:bytes.byteLength};
    await report({service:observation,renders:{[request.request_id || `cache-${doc.revision}`]:observation}});
    publish({last:meta,status:'rendered'});
    return receipt;
  }
  function enqueue(fn) { const result = tail.then(() => {alive();return fn();}); tail = result.catch(() => {}); return result; }
  async function accept(data,via='poll') {
    if(controller.signal.aborted) return;
    const work = [];
    for(const request of data.requests || data.pending || []) {
      if(handled.has(request.request_id) || inflight.has(request.request_id)) continue;
      inflight.add(request.request_id);
      work.push(enqueue(() => renderOne(request,via)).then(() => handled.add(request.request_id))
        .catch(error => {if(!controller.signal.aborted) {publish({status:'error',error:String(error)}); throw error;}})
        .finally(() => inflight.delete(request.request_id)));
    }
    await Promise.all(work);
  }
  function cache(document) {
    if(controller.signal.aborted || cacheRevision===document.revision) return Promise.resolve();
    cacheRevision=document.revision;
    return enqueue(() => renderOne({document,kind:'preview'},'poll',true)).catch(error => {
      cacheRevision=null; if(!controller.signal.aborted) {publish({status:'error',error:String(error)}); throw error;}
    });
  }
  function dispose() { if(controller.signal.aborted) return; controller.abort(); renderer.dispose(); listeners.clear(); }
  ctx.onDispose(dispose);
  return {accept,cache,report,rest,renderer,signal:controller.signal,dispose,
    render:(document,time=0,options)=>enqueue(()=>renderer.render(document,time,options)),
    getSnapshot:()=>snapshot,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);},
    page(active) {pageCount=Math.max(0,pageCount+(active?1:-1));publish({page_active:pageCount>0});},metadata};
}
