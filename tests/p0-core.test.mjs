import test from 'node:test';
import assert from 'node:assert/strict';

test('RGBA metrics independently measure black/white contrast, clipping and detail', async () => {
  const module = await import('../core/metrics.mjs').catch(() => ({}));
  assert.equal(typeof module.frameMetrics, 'function', 'frameMetrics feature missing');
  const result = module.frameMetrics(new Uint8Array([0,0,0,255,255,255,255,255]), 2, 1);
  assert.ok(Math.abs(result.mean_luma - 0.5) < 1e-12);
  assert.ok(Math.abs(result.std_luma - 0.5) < 1e-12);
  assert.equal(result.shadow_clipping_pct, 50);
  assert.equal(result.highlight_clipping_pct, 50);
  assert.ok(Math.abs(result.detail_density - 1) < 1e-12);
  assert.equal(result.nearly_uniform, false);
  assert.equal(result.dominant_colors.length, 2);
});
