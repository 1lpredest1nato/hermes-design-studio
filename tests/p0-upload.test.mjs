import test from 'node:test';
import assert from 'node:assert/strict';
test('chunk uploader sends sequential 4MiB pieces and verifies backend full SHA',async()=>{
 const mod=await import('../hermes/upload.mjs').catch(()=>({}));
 assert.equal(typeof mod.uploadChunks,'function','upload feature missing');
 const blob=new Blob([new Uint8Array(4*1024*1024+9)]);
 const requests=[],progress=[];
 const rest=async(path,opts)=>{requests.push({path,opts});const q=new URLSearchParams(path.split('?')[1]);return Number(q.get('index'))===1?{complete:true,sha256:q.get('sha256')}:{received:true};};
 const result=await mod.uploadChunks(blob,{rest,signal:new AbortController().signal,onProgress:p=>progress.push(p)});
 assert.equal(requests.length,2);assert.equal(requests[0].opts.upload.bytes.byteLength,4*1024*1024);
 assert.equal(requests[1].opts.upload.bytes.byteLength,9);assert.equal(progress.length,2);
 assert.equal(result.sha256_match,true);
});
