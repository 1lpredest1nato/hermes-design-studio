/** Small, bounded real-GPU checks against CPU reference pixels, never GPU-derived goldens.
 * Fixture arithmetic and reference algorithms intentionally do not read shader text.
 */
const W=8,H=8;
function fixture(){const rgba=new Uint8Array(W*H*4);for(let y=0;y<H;y++)for(let x=0;x<W;x++)rgba.set([(x*31+y*17)%256,(x*13+y*37)%256,(x*47+y*7)%256,64+((x+y)*19)%192],(y*W+x)*4);return {width:W,height:H,rgba};}
const clamp=v=>Math.min(1,Math.max(0,v));
const byte=v=>Math.round(clamp(v)*255);
const luma=c=>0.2126*c[0]+0.7152*c[1]+0.0722*c[2];
function sample(src,x,y){x=Math.max(0,Math.min(W-1,Math.floor(x)));y=Math.max(0,Math.min(H-1,Math.floor(y)));return [...src.rgba.slice((y*W+x)*4,(y*W+x+1)*4)];}
function expectedPixels(src,fn){const out=[];for(let y=0;y<H;y++)for(let x=0;x<W;x++)out.push(...fn(sample(src,x,y),x,y));return out;}
function colorLinear(hex){return [1,3,5].map(i=>{const v=parseInt(hex.slice(i,i+2),16)/255;return v<=0.04045?v/12.92:((v+.055)/1.055)**2.4;});}
function colorBytes(c){return c.map(v=>byte(v<=.0031308?v*12.92:1.055*v**(1/2.4)-.055));}
function palette(a,b,t){a=colorLinear(a);b=colorLinear(b);return colorBytes(a.map((v,i)=>v*(1-t)+b[i]*t));}
// Independently expand ordered threshold tiles by quadrant; shader uses integer bit ranks.
function bayer(n){let m=[[0]];for(let s=1;s<n;s*=2){const next=Array.from({length:s*2},()=>[]);for(let y=0;y<s*2;y++)for(let x=0;x<s*2;x++)next[y][x]=4*m[y%s][x%s]+[[0,2],[3,1]][Math.floor(y/s)][Math.floor(x/s)];m=next;}return m;}
function ditherReference(src,p){const n=Number(p.matrix),matrix=bayer(n);return expectedPixels(src,(c,x,y)=>{const levels=p.use_palette?2:p.levels;const q=clamp(Math.floor(luma(c)/255*(levels-1)+(matrix[y%n][x%n]+.5)/(n*n))/(levels-1));return [...(p.use_palette?palette(p.dark,p.light,q):[byte(q),byte(q),byte(q)]),c[3]];});}
function grainNoise(x,y,seed){const mask=0xffffffffn;let n=(BigInt(x)*1973n+BigInt(y)*9277n+BigInt(seed)*26699n)&mask;n=((n^(n>>13n))*1274126177n)&mask;n=(n^(n>>16n))&mask;return Number(n&65535n)/65535-.5;}
function levelsReference(src,p){return expectedPixels(src,c=>{const adjusted=c.slice(0,3).map(v=>clamp((v/255+p.brightness-.5)*p.contrast+.5)**(1/p.gamma));const gray=luma(adjusted);return [...adjusted.map(v=>byte(gray+(v-gray)*p.saturation)),c[3]];});}
const suites={
 levels:[{}, {brightness:.2},{contrast:1.5},{gamma:1.8},{saturation:0},{brightness:-.1,contrast:.8,gamma:1.4,saturation:1.6}].map(p=>({params:{brightness:0,contrast:1,gamma:1,saturation:1,...p},reference:levelsReference})),
 chromatic_aberration:[{offset:1,angle:0},{offset:2,angle:90}].map(params=>({params,reference:(src,p)=>expectedPixels(src,(c,x,y)=>{const dx=p.offset*Math.cos(p.angle*Math.PI/180),dy=p.offset*Math.sin(p.angle*Math.PI/180);return [sample(src,x+.5+dx,y+.5+dy)[0],c[1],sample(src,x+.5-dx,y+.5-dy)[2],c[3]];})})),
 grain:[0,.4].map(amount=>({params:{amount},reference:(src,p)=>expectedPixels(src,(c,x,y)=>[...c.slice(0,3).map(v=>byte(v/255+p.amount*grainNoise(x,y,17))),c[3]])})),
 gradient_map:[false,true].map(three_colors=>({params:{three_colors,dark:'#204060',middle:'#d09030',light:'#f0e0a0'},reference:(src,p)=>expectedPixels(src,c=>{const t=luma(c)/255;return [...(!p.three_colors?palette(p.dark,p.light,t):t<.5?palette(p.dark,p.middle,t*2):palette(p.middle,p.light,t*2-1)),c[3]];})})),
 halftone:[{size:3,angle:0},{size:4,angle:37}].map(params=>({params,reference:(src,p)=>expectedPixels(src,(c,x,y)=>{const a=p.angle*Math.PI/180,xx=(x+.5)*Math.cos(a)-(y+.5)*Math.sin(a),yy=(x+.5)*Math.sin(a)+(y+.5)*Math.cos(a);const dx=((xx/p.size)%1+1)%1-.5,dy=((yy/p.size)%1+1)%1-.5;const value=dx*dx+dy*dy<=(1-luma(c)/255)*.25?0:255;return [value,value,value,c[3]];})})),
 dither:[2,4,8].flatMap(n=>[2,5,8].map(levels=>({params:{matrix:String(n),levels,use_palette:false},reference:ditherReference}))).concat([{params:{matrix:'4',levels:3,use_palette:true,dark:'#204060',light:'#e0c080'},reference:ditherReference}]),
 pixelate:[{params:{size:2},reference:(src,p)=>expectedPixels(src,(_,x,y)=>sample(src,Math.floor(x/p.size)*p.size+p.size/2,Math.floor(y/p.size)*p.size+p.size/2))}],
};
export async function runDiagnostics(renderer,tools){
 const source=fixture(),checks=[];
 const names=['pixelate','dither','halftone','gradient_map','grain','chromatic_aberration','levels'];
 for(const name of names){const ref=`builtin/${name}@1`,entry=tools.find(e=>(e.ref||`${e.manifest.id}@${e.manifest.version}`)===ref),cases=[];
  if(!entry||!suites[name]){checks.push({tool:ref,pass:false,error:!entry?'Builtin missing':'Independent reference missing'});continue;}
  for(const spec of suites[name]){try{const expected=spec.reference(source,spec.params);const frame=await renderer.render({format:1,source:{w:W,h:H},stack:[{tool:ref,params:spec.params}],seed:17,timeline:null},0,{tools:[entry],source});let max_error=0,mismatched=0;for(let i=0;i<expected.length;i++){const error=Math.abs(frame.rgba[i]-expected[i]);max_error=Math.max(max_error,error);if(error>(spec.tolerance??1))mismatched++;}cases.push({params:spec.params,pass:mismatched===0,max_error,mismatched_channels:mismatched,compared_channels:expected.length,expected_first_pixels:expected.slice(0,16),actual_first_pixels:[...frame.rgba.slice(0,16)],metrics:frame.metrics});}catch(e){cases.push({params:spec.params,pass:false,error:String(e)});}}
  checks.push({tool:ref,pass:cases.length>0&&cases.every(c=>c.pass),cases});
 }
 return {format:1,pass:checks.length===7&&checks.every(c=>c.pass),checks,fixture:{width:W,height:H,description:'deterministic asymmetric RGBA8 pattern; top-down straight alpha'},comparison:'all channels against independent CPU references; RGBA8 tolerance 1 byte unless stated',renderer:renderer.info};
}
