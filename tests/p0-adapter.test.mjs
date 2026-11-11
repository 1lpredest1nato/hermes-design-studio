import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('Desktop adapter declares permanent SDK query mount, both pages and user-only download',async()=>{
 const source=await readFile(new URL('../hermes/plugin.jsx',import.meta.url),'utf8').catch(()=> '');
 assert.ok(source.includes('TITLEBAR_AREAS.right'),'permanent service mount missing');
 assert.ok(source.includes('useQuery('));assert.ok(source.includes('ctx.onEvent('));
 assert.ok(source.includes("'/design-studio/diagnostics'"));
 assert.ok(source.includes("id:'design-studio.open',label:"),'SDK palette id/label/run signature missing');
 assert.ok(source.includes('drawImage(bitmap,0,0)'),'imported image needs real PNG encoding for Save as');
 assert.ok(source.includes('service.render(fixture,0)'),'page must share serialized renderer queue');
 assert.ok(source.includes('download='));assert.ok(source.includes('type="file"'));
 assert.ok(!/requestAnimationFrame|setInterval|window\.hermesDesktop|new Function|eval\(/.test(source));
});
