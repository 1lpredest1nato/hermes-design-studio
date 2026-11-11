/** sRGB byte metrics. All buffers top-down; differences are mean absolute RGB /255.
 * Alpha is reported separately from RGB: transparent RGB remains measurable, not composited.
 */
export function frameMetrics(rgba, width, height, {source,previous}={}) {
  if (rgba.length !== width * height * 4 || !width || !height) throw new Error('Invalid RGBA dimensions');
  const count = width * height;
  const lumas = new Float64Array(count);
  let sum = 0, square = 0, shadows = 0, highlights = 0, gradients = 0, edges = 0;
  const histogram = new Map();
  for (let i = 0; i < count; i++) {
    const at = i * 4;
    const value = (0.2126 * rgba[at] + 0.7152 * rgba[at+1] + 0.0722 * rgba[at+2]) / 255;
    lumas[i] = value; sum += value; square += value * value;
    shadows += value <= 0.01; highlights += value >= 0.99;
    const hex = '#' + [rgba[at], rgba[at+1], rgba[at+2]].map(v => (Math.min(15, v >> 4) * 17).toString(16).padStart(2, '0')).join('');
    histogram.set(hex, (histogram.get(hex) || 0) + 1);
    if (i % width) { gradients += Math.abs(value - lumas[i-1]); edges++; }
    if (i >= width) { gradients += Math.abs(value - lumas[i-width]); edges++; }
  }
  const mean = sum / count, std = Math.sqrt(Math.max(0, square/count - mean*mean));
  function difference(frame){
    if(!frame||frame.width!==width||frame.height!==height||frame.rgba?.length!==rgba.length)return null;
    let total=0;for(let i=0;i<rgba.length;i+=4)for(let c=0;c<3;c++)total+=Math.abs(rgba[i+c]-frame.rgba[i+c]);return total/(count*3*255);
  }
  return { width, height, mean_luma: mean, std_luma: std, shadow_clipping_pct: shadows/count*100,
    highlight_clipping_pct: highlights/count*100, detail_density: edges ? gradients/edges : 0,
    dominant_colors: [...histogram].sort((a,b) => b[1]-a[1]).slice(0,5).map(([hex,n]) => ({hex, fraction:n/count})),
    nearly_uniform: std < 0.005, difference_source: difference(source), difference_previous: difference(previous),
    metrics_scope: 'sRGB uncomposited RGB; differences mean absolute RGB /255; unavailable or mismatched comparison is null' };
}
