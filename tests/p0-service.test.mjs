import test from 'node:test';
import assert from 'node:assert/strict';
const doc = {format:1,id:'p0',revision:0,source:null,stack:[],seed:1234,timeline:null};
function rig(createService) {
  const calls = [], cleanups = [];
  let finish;
  const ctx = { rest: async (path,opts) => { calls.push({path,opts}); return {ok:true}; }, onDispose: fn => cleanups.push(fn) };
  let disposed = 0;
  const renderer = {render: () => new Promise(resolve => {finish = resolve;}), dispose: () => disposed++};
  const service = createService(ctx,renderer,{runId:'test-run',build:'test-build'});
  return {service,calls,cleanups, finish: () => finish({blob:new Blob(['png'],{type:'image/png'}),metrics:{width:2,height:2},width:2,height:2}), disposed: () => disposed};
}
test('detached service answers request while page is inactive and deduplicates id', async () => {
  const mod = await import('../hermes/service.mjs').catch(() => ({}));
  assert.equal(typeof mod.createService,'function','service feature missing');
  const r = rig(mod.createService);
  const work = r.service.accept({requests:[{request_id:'r1',kind:'preview',document:doc}]},'poll');
  await Promise.resolve(); r.finish(); await work;
  await r.service.accept({requests:[{request_id:'r1',kind:'preview',document:doc}]},'event');
  assert.equal(r.calls.filter(c => c.path.startsWith('/render/response')).length,1);
  const response = r.calls.find(c => c.path.startsWith('/render/response'));
  const meta = JSON.parse(new URLSearchParams(response.path.split('?')[1]).get('meta'));
  assert.equal(meta.page_active,false); assert.equal(meta.detached_canvas,true);
  assert.equal(meta.run_id,'test-run'); assert.equal(meta.revision,0);
  const report=r.calls.find(c=>c.path==='/report').opts.body;
  assert.equal(report.runs['test-run'].service.request_id,'r1');
  assert.equal(report.runs['test-run'].renders.r1.page_active,false);
});
test('plugin unload during PNG encoding disposes GPU and prevents every POST continuation',async()=>{
 const {createService}=await import('../hermes/service.mjs');const r=rig(createService);
 const work=r.service.accept({requests:[{request_id:'cancel',kind:'export',document:doc}]});
 await Promise.resolve();r.cleanups[0]();r.finish();await work;
 assert.equal(r.disposed(),1);assert.equal(r.calls.length,0);assert.equal(r.service.signal.aborted,true);
 await r.service.accept({requests:[{request_id:'late',kind:'export',document:doc}]});
 assert.equal(r.calls.length,0);
});
test('plugin unload while response IPC is pending never submits follow-up report',async()=>{
 const {createService}=await import('../hermes/service.mjs');let release;const calls=[];let cleanup;
 const ctx={onDispose:fn=>cleanup=fn,rest:(path)=>{calls.push(path);return new Promise(resolve=>release=resolve);}};
 const renderer={render:async()=>({blob:new Blob(['x']),metrics:{},width:1,height:1}),dispose(){}};
 const service=createService(ctx,renderer,{runId:'cancel-ipc',build:'test'});
 const work=service.accept({requests:[{request_id:'pending',kind:'preview',document:doc}]});
 for(let n=0;n<10&&!release;n++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(calls.length,1);cleanup();release({ok:true});await work;assert.equal(calls.length,1);
});
