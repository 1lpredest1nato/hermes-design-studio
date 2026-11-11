const CHUNK=4*1024*1024;
function check(signal){if(signal.aborted)throw new DOMException('Upload cancelled','AbortError');}
export async function uploadChunks(blob,{rest,signal,onProgress=()=>{}}) {
 check(signal);
 const bytes=await blob.arrayBuffer();check(signal);
 const digest=await crypto.subtle.digest('SHA-256',bytes);check(signal);
 const sha256=[...new Uint8Array(digest)].map(v=>v.toString(16).padStart(2,'0')).join('');
 const id=crypto.randomUUID().replaceAll('-','');
 const total=Math.ceil(bytes.byteLength/CHUNK);if(!total)throw new Error('Empty upload');
 let receipt;
 for(let index=0;index<total;index++) {
  check(signal);
  receipt=await rest(`/assets/upload?id=${id}&index=${index}&total=${total}&sha256=${sha256}`,{
   method:'POST',upload:{filename:`part-${index}.bin`,contentType:'application/octet-stream',bytes:bytes.slice(index*CHUNK,(index+1)*CHUNK)},timeoutMs:30000});
  check(signal);
  await onProgress({id,index,total,bytes_received:Math.min((index+1)*CHUNK,bytes.byteLength),bytes_total:bytes.byteLength,receipt,sha256});check(signal);
 }
 const actual=receipt.sha256 || receipt.asset?.sha256;
 if(actual!==sha256)throw new Error(`Backend SHA mismatch or missing SHA: ${actual || 'missing'}`);
 return {id,sha256,sha256_match:true,bytes:bytes.byteLength,total,receipt};
}
/** Bounded 2560x2400 high entropy RGBA PNG: actual encoded size must pass. */
export async function makeUploadProbe(canvas,signal) {
 check(signal);canvas.width=2560;canvas.height=2400;
 const ctx=canvas.getContext('2d');if(!ctx)throw new Error('2D canvas unavailable');
 const image=ctx.createImageData(canvas.width,canvas.height);
 // Four random channels avoid compressible alpha; crypto calls obey 65536-byte ceiling.
 for(let offset=0;offset<image.data.length;offset+=65536) {
  check(signal);crypto.getRandomValues(image.data.subarray(offset,Math.min(offset+65536,image.data.length)));
 }
 ctx.putImageData(image,0,0);
 const blob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('Probe PNG encoding failed')),'image/png'));
 check(signal);if(blob.size<20*1024*1024)throw new Error(`Probe PNG ${blob.size} bytes below 20MiB; not counted`);
 return blob;
}
