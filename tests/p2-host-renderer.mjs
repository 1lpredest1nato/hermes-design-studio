// Secondary integration only: real browser GPU + PluginHost, not Electron/SDK or LLM.
import {writeFile} from 'node:fs/promises';
const {chromium}=await import('/home/destino/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
const browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
let page;
try {
 page=await browser.newPage();await page.goto(process.argv[2]);
 await page.evaluate(async()=>{
  const {createRenderer}=await import('/core/renderer.mjs');
  const {createService}=await import('/hermes/service.mjs');
  const failures=[];
  const ctx={onDispose(){},rest:async(path,opts={})=>{
   const headers={};let body;
   if(opts.upload){const f=new FormData();f.append('file',new Blob([opts.upload.bytes],{type:opts.upload.contentType}),opts.upload.filename);body=f;}
   else if(opts.body!==undefined){headers['content-type']='application/json';body=JSON.stringify(opts.body);}
   const response=await fetch('/api'+path,{method:opts.method||'GET',headers,body});
   const result=await response.json();if(!response.ok)throw Object.assign(new Error(JSON.stringify(result)),{status:response.status});return result;
  }};
  const renderer=createRenderer(document.createElement('canvas'));
  const service=createService(ctx,renderer,{runId:crypto.randomUUID(),build:'p2-host-secondary-real-gpu'});
  const state={service,stop:false,failures};globalThis.__p2=state;
  state.loop=(async()=>{while(!state.stop){try{const s=await service.getState();await service.accept(s,'headless-host-poll');await service.cache(s.document);}catch(e){failures.push(String(e));}await new Promise(r=>setTimeout(r,100));}})();
 });
 process.stdout.write('ready\n');
 await new Promise(resolve=>process.stdin.once('data',resolve));
 process.stdin.pause();
 const report=await page.evaluate(async()=>{const s=globalThis.__p2;s.stop=true;await s.loop;const metadata=s.service.metadata();s.service.dispose();return {metadata,errors:s.failures};});
 report.browser_version=await browser.version();report.scope='Real software WebGL and real PluginHost HTTP; not Desktop SDK or agent session';
 await writeFile(process.argv[3],JSON.stringify(report,null,2)+'\n');
 if(report.errors.length)process.exitCode=1;
}finally{await browser.close();}
