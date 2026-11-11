// Authenticated, namespace-scoped SDK REST. No direct URLs/credential access.
export async function loadAsset(rest,asset,signal) {
 const match=/^assets\/([a-f0-9]{64})\.png$/.exec(asset||'');
 if(!match)throw new Error('Invalid content-addressed asset reference');
 const alive=()=>{if(signal.aborted)throw new DOMException('Asset read cancelled','AbortError');};
 const chunks=[];let offset=0,total=null,mime='image/png';
 do {
  alive();
  const part=await rest(`/assets/read?sha=${match[1]}&offset=${offset}&length=1048576`);
  alive();
  if(!Number.isSafeInteger(part.total)||part.total<=0||part.total>1024*1024*1024||part.offset!==offset||
    (total!==null&&part.total!==total))throw new Error('Invalid asset read response');
  total=part.total;mime=part.mime;
  const bytes=Uint8Array.from(atob(part.base64),c=>c.charCodeAt(0));
  if(!bytes.length||bytes.length>1048576||part.bytes!==bytes.length||offset+bytes.length>total)throw new Error('Invalid asset chunk length');
  chunks.push(bytes);offset+=bytes.length;
 }while(offset<total);
 const blob=new Blob(chunks,{type:mime});
 const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());alive();
 const hash=[...new Uint8Array(digest)].map(n=>n.toString(16).padStart(2,'0')).join('');
 if(hash!==match[1])throw new Error('Asset content hash mismatch');
 return blob;
}
