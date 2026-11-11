// Real browser diagnostics acceptance. Independent CPU expectations live in core/diagnostics.mjs.
import {createServer} from 'node:http';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve,extname} from 'node:path';
import assert from 'node:assert/strict';
const {chromium}=await import('/home/destino/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs');
const root=resolve(new URL('..',import.meta.url).pathname),tools=[],fixtures=[];
try{for(const name of await readdir(root+'/tools/builtin')){const p=root+'/tools/builtin/'+name;const manifest=JSON.parse(await readFile(p+'/manifest.json','utf8'));tools.push({manifest,shader:await readFile(p+'/shader.frag','utf8'),ref:`${manifest.id}@${manifest.version}`,status:'builtin'});try{fixtures.push(JSON.parse(await readFile(p+'/fixture.json','utf8')));}catch{}}}catch{}
const server=createServer(async(req,res)=>{try{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('Diagnostics');return;}const path=resolve(root,'.'+new URL(req.url,'http://local').pathname);if(!path.startsWith(root+'/'))throw Error('path');res.setHeader('Content-Type',extname(path)==='.mjs'?'text/javascript':'text/plain');res.end(await readFile(path));}catch{res.writeHead(404);res.end('missing');}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
try{browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--use-angle=swiftshader','--enable-unsafe-swiftshader']});const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
const result=await page.evaluate(async ({tools,fixtures})=>{
 const {createRenderer}=await import('/core/renderer.mjs');const renderer=createRenderer(document.createElement('canvas'));
 try{const m=await import('/core/diagnostics.mjs').catch(()=>null);if(!m?.runDiagnostics)return {pass:false,checks:[],error:'runDiagnostics missing'};
 const report=await m.runDiagnostics(renderer,tools);report.fixed_checks=[];
 for(const fixture of fixtures){const {width,height,rgba}=fixture.source;const source={width,height,rgba:new Uint8Array(rgba)};const frame=await renderer.render({format:1,source:{w:width,h:height},stack:[{tool:fixture.tool,params:fixture.params}],seed:fixture.seed,timeline:null},0,{source,tools});let max_error=0;for(let i=0;i<fixture.expected.length;i++)max_error=Math.max(max_error,Math.abs(frame.rgba[i]-fixture.expected[i]));report.fixed_checks.push({tool:fixture.tool,pass:frame.rgba.length===fixture.expected.length&&max_error<=1,max_error,compared_channels:fixture.expected.length});}
 const modified=tools.map(e=>e.manifest.id==='builtin/pixelate'?{...e,shader:'void main(){outColor=vec4(0.0);}'}:e);const broken=await m.runDiagnostics(renderer,modified);report.mutation_detected=broken.pass===false&&broken.checks.find(c=>c.tool==='builtin/pixelate@1')?.pass===false;
 return report;}finally{renderer.dispose();}
},{tools,fixtures});
result.browser_version=await browser.version();result.evidence_scope="standalone Chromium software-WebGL2; no Hermes runtime";
console.log(JSON.stringify(result,null,2));if(process.env.P1_EVIDENCE)await writeFile(resolve(root,process.env.P1_EVIDENCE),JSON.stringify(result,null,2)+'\n');
const requested=(process.env.P1_TOOLS||'pixelate,dither,halftone,gradient_map,grain,chromatic_aberration,levels').split(',');
for(const name of requested){const check=result.checks.find(c=>c.tool===`builtin/${name}@1`);assert.ok(check,`${name} diagnostic missing`);assert.equal(check.pass,true,`${name} diagnostic pixels failed`);}
if(requested.length===7){assert.equal(result.pass,true);assert.equal(result.fixed_checks.length,7,'seven static JSON fixtures required');assert.ok(result.fixed_checks.every(c=>c.pass),'static fixture pixels differ');assert.equal(result.mutation_detected,true,'broken shader must fail independent diagnostics');}
}finally{await browser?.close();await new Promise(r=>server.close(r));}
