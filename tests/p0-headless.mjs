// Secondary standalone Chromium evidence ONLY; not a Desktop or SDK test.
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import('/home/destino/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
const root=resolve(new URL('..',import.meta.url).pathname);
const server=createServer(async(req,res)=>{
 try {if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('Secondary renderer harness');return;}
 const path=resolve(root,'.'+new URL(req.url,'http://local').pathname);if(!path.startsWith(root+'/'))throw new Error('path');
 res.setHeader('Content-Type',extname(path)==='.mjs'?'text/javascript':'text/plain');res.end(await readFile(path));}
 catch{res.writeHead(404);res.end('Not found');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
 browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
 const result=await page.evaluate(async()=>{
  const {createRenderer}=await import('/core/renderer.mjs');const canvas=document.createElement('canvas');
  const renderer=createRenderer(canvas);const doc={format:1,id:'p0',revision:0,source:{w:2,h:2},stack:[],seed:1234,timeline:null};
  const frame=await renderer.render(doc,0);const pixels=Array.from(frame.rgba);const signature=Array.from(new Uint8Array(await frame.blob.arrayBuffer()).slice(0,8));
  renderer.dispose();let disposedError='';try{await renderer.render(doc,0);}catch(e){disposedError=String(e);}
  const {makeUploadProbe}=await import('/hermes/upload.mjs');const probe=await makeUploadProbe(document.createElement('canvas'),new AbortController().signal);
  const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await probe.arrayBuffer()))).map(v=>v.toString(16).padStart(2,'0')).join('');
  return {evidence_scope:'secondary standalone Chromium software-WebGL, no SDK/gateway transport',detached_canvas:!canvas.isConnected,pixels,signature,metrics:frame.metrics,disposedError,probe_png_bytes:probe.size,probe_sha256:sha256};
 });
 assert.equal(result.detached_canvas,true);assert.deepEqual(result.signature,[137,80,78,71,13,10,26,10]);
 const expected=[64,64,64,255,191,64,64,255,64,191,64,255,191,191,64,255];
 assert.ok(result.pixels.every((v,i)=>Math.abs(v-expected[i])<=1));assert.match(result.disposedError,/disposed/);
 assert.ok(result.probe_png_bytes>=20*1024*1024);
 console.log(JSON.stringify(result,null,2));
} finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
