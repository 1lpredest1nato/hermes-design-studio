import test from 'node:test';
import assert from 'node:assert/strict';
test('renderer refuses unavailable WebGL2 rather than silently substituting Canvas2D', async () => {
 const mod = await import('../core/renderer.mjs').catch(() => ({}));
 assert.equal(typeof mod.createRenderer,'function','renderer feature missing');
 assert.throws(()=>mod.createRenderer({getContext:()=>null}),/WebGL2/);
});
