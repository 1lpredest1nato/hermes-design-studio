import {frameMetrics} from './metrics.mjs';
const vertex = `#version 300 es
out vec2 v_uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);v_uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}`;
const header = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_uv;
out vec4 outColor;
`;
const copy = 'void main(){outColor=texture(u_input,v_uv);}';
const blending = `uniform sampler2D u_effect;
uniform float u_opacity;
uniform int u_blend;
void main(){vec4 b=texture(u_input,v_uv),s=texture(u_effect,v_uv);vec3 c=s.rgb;
if(u_blend==1)c=b.rgb*s.rgb;
if(u_blend==2)c=1.0-(1.0-b.rgb)*(1.0-s.rgb);
if(u_blend==3)c=mix(2.0*b.rgb*s.rgb,1.0-2.0*(1.0-b.rgb)*(1.0-s.rgb),step(vec3(0.5),b.rgb));
outColor=vec4(mix(b.rgb,c,u_opacity),mix(b.a,s.a,u_opacity));}`;
function shaderHash(text){let h=2166136261;for(let i=0;i<text.length;i++){h^=text.charCodeAt(i);h=Math.imul(h,16777619);}return (h>>>0).toString(16);}
function parameterDeclarations(params){return params.map(p=>{if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p.name))throw Error('Invalid uniform name');const type={float:'float',int:'int',bool:'bool',color:'vec3',enum:'int'}[p.type];if(!type)throw Error('Invalid parameter type');return `uniform ${type} p_${p.name};`;}).join('\n');}
function linearColor(hex){if(!/^#[0-9a-f]{6}$/i.test(hex))throw Error('Invalid color uniform');return [1,3,5].map(i=>{const s=parseInt(hex.slice(i,i+2),16)/255;return s<=0.04045?s/12.92:((s+0.055)/1.055)**2.4;});}
const present = 'void main(){outColor=texture(u_input,vec2(v_uv.x,1.0-v_uv.y));}';
/** Host-independent WebGL2 renderer.
 * Public RGBA buffers and all effect UVs are top-down, straight alpha. Internal
 * FBO row zero represents the image's top. Presentation flips once into the
 * browser canvas; readback flips its rows back to the public buffer convention.
 * No fixed-function alpha blending: each effect mixes straight RGB and alpha
 * with its input at node opacity, avoiding premultiplication/dark-edge artifacts.
 * Catalog callers must statically validate user shaders before compilation;
 * compilation here is not a GPU sandbox. GPU work is synchronous, only PNG
 * encoding yields. Service callers serialize renders on their own queue.
 */
export function createRenderer(canvas){
 const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true,alpha:true,premultipliedAlpha:false,antialias:false});
 if(!gl)throw new Error('WebGL2 unavailable; no renderer fallback enabled');
 const limit=gl.getParameter(gl.MAX_TEXTURE_SIZE),vao=gl.createVertexArray(),cache=new Map();let disposed=false;
 function compile(source){
  const program=gl.createProgram(),shaders=[];
  try{for(const [type,text] of [[gl.VERTEX_SHADER,vertex],[gl.FRAGMENT_SHADER,header+source]]){const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,text);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error('GLSL compile: '+gl.getShaderInfoLog(s));gl.attachShader(program,s);}gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error('GLSL link: '+gl.getProgramInfoLog(program));return program;}catch(e){gl.deleteProgram(program);throw e;}finally{for(const s of shaders)gl.deleteShader(s);}
 }
 function program(key,source){
  // Include complete source to make hash collisions harmless. Keep a bounded GPU cache.
  const k=key+'|'+shaderHash(source)+'|'+source;
  if(cache.has(k)){const p=cache.get(k);cache.delete(k);cache.set(k,p);return p;}
  const p=compile(source);cache.set(k,p);if(cache.size>64){const oldest=cache.keys().next().value;gl.deleteProgram(cache.get(oldest));cache.delete(oldest);}return p;
 }
 function toolProgram(entry){const m=entry.manifest;if(m?.format!==1||m.kind&&m.kind!=='shader'||typeof entry.shader!=='string')throw Error('Unsupported tool format/kind');return program(`${m.id}@${m.version}`,parameterDeclarations(m.params||[])+'\n#line 1\n'+entry.shader);}
 function uniforms(p,entry,values){for(const spec of entry.manifest.params||[]){const value=values[spec.name]??spec.default,loc=gl.getUniformLocation(p,'p_'+spec.name);switch(spec.type){case 'float':if(!Number.isFinite(value))throw Error('Invalid float parameter '+spec.name);gl.uniform1f(loc,value);break;case 'int':if(!Number.isInteger(value))throw Error('Invalid int parameter '+spec.name);gl.uniform1i(loc,value);break;case 'bool':if(typeof value!=='boolean')throw Error('Invalid bool parameter '+spec.name);gl.uniform1i(loc,value?1:0);break;case 'enum':{const options=spec.options||spec.values||[];const index=options.findIndex(o=>(typeof o==='object'?o.value:o)===value);if(index<0)throw Error('Invalid enum parameter '+spec.name);gl.uniform1i(loc,index);break;}case 'color':gl.uniform3fv(loc,linearColor(value));break;}}}
 function dispose(){if(disposed)return;disposed=true;for(const p of cache.values())gl.deleteProgram(p);cache.clear();gl.deleteVertexArray(vao);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.width=1;canvas.height=1;}
 function render(doc,time=0,{kind='preview',max_size=1600,source,tools=[],previous}={}){
  if(disposed)throw Error('Renderer disposed');if(doc?.format!==1)throw Error('Unsupported project format');if(time!==0)throw Error('Static renderer reserves u_time=0');
  if(!['preview','export'].includes(kind))throw Error('Invalid render kind');
  let width=doc.source?.w??source?.width??640,height=doc.source?.h??source?.height??400;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw Error('Invalid dimensions');
  if(!Number.isFinite(max_size)||max_size<1)throw Error('Invalid preview max_size');
  const cap=Math.min(limit,kind==='export'?4096:Math.min(1600,Math.floor(max_size)));
  if(kind==='export'&&Math.max(width,height)>cap)throw Error(`Export exceeds ${cap}px GPU/export limit`);
  const scale=Math.min(1,cap/Math.max(width,height));width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));
  let input;
  if(source?.rgba){if(!Number.isInteger(source.width)||!Number.isInteger(source.height)||source.width<1||source.height<1||source.rgba.length!==source.width*source.height*4)throw Error('Invalid source RGBA dimensions');input=source;}
  else if(source){const c=document.createElement('canvas');c.width=width;c.height=height;const cx=c.getContext('2d',{willReadFrequently:true});cx.drawImage(source,0,0,width,height);input={rgba:cx.getImageData(0,0,width,height).data,width,height};}
  else if(doc.source?.asset)throw Error('Project asset source was not supplied');
  else{const rgba=new Uint8Array(width*height*4);for(let y=0;y<height;y++)for(let x=0;x<width;x++){const i=(y*width+x)*4;rgba.set([Math.round((x+.5)/width*255),Math.round((1-(y+.5)/height)*255),64,255],i);}input={rgba,width,height};}
  if(input.width>limit||input.height>limit)throw Error(`Source exceeds ${limit}px GPU texture limit`);
  const textures=[],fbos=[];
  function texture(w,h,data){const t=gl.createTexture();textures.push(t);gl.bindTexture(gl.TEXTURE_2D,t);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.pixelStorei(gl.UNPACK_ALIGNMENT,1);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,w,h,0,gl.RGBA,gl.UNSIGNED_BYTE,data);return t;}
  function target(){const t=texture(width,height,null),f=gl.createFramebuffer();fbos.push(f);gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,t,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Incomplete RGBA8 framebuffer');return {t,f};}
  function draw(p,t,f,setup=()=>{}){gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.viewport(0,0,width,height);gl.useProgram(p);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,t);gl.uniform1i(gl.getUniformLocation(p,'u_input'),0);gl.uniform2f(gl.getUniformLocation(p,'u_resolution'),width,height);gl.uniform1f(gl.getUniformLocation(p,'u_time'),0);gl.uniform1f(gl.getUniformLocation(p,'u_seed'),doc.seed||0);setup();gl.drawArrays(gl.TRIANGLES,0,3);}
  let rgba,sourceRGBA;
  try{canvas.width=width;canvas.height=height;gl.disable(gl.BLEND);gl.disable(gl.DITHER);gl.bindVertexArray(vao);const uploaded=texture(input.width,input.height,input.rgba);const a=target();draw(program('copy',copy),uploaded,a.f);
   sourceRGBA=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,sourceRGBA);
   let current=a;
   if((doc.stack||[]).some(n=>n.enabled!==false&&(n.opacity??1)!==0)){
    const b=target(),effect=target();
    for(const node of doc.stack||[]){if(node.enabled===false||(node.opacity??1)===0)continue;
     const entry=tools.find(e=>(e.ref||`${e.manifest.id}@${e.manifest.version}`)===node.tool);if(!entry)throw Error('Unknown tool '+node.tool);
     const opacity=node.opacity??1,blend=node.blend??'normal';if(!Number.isFinite(opacity)||opacity<0||opacity>1||!['normal','multiply','screen','overlay'].includes(blend))throw Error('Invalid node opacity/blend');
     const p=toolProgram(entry);draw(p,current.t,effect.f,()=>uniforms(p,entry,node.params||{}));
     const next=current===a?b:a,bp=program('blend',blending);draw(bp,current.t,next.f,()=>{gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,effect.t);gl.uniform1i(gl.getUniformLocation(bp,'u_effect'),1);gl.uniform1f(gl.getUniformLocation(bp,'u_opacity'),opacity);gl.uniform1i(gl.getUniformLocation(bp,'u_blend'),['normal','multiply','screen','overlay'].indexOf(blend));});current=next;
    }
   }
   draw(program('present',present),current.t,null);const bottom=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,bottom);rgba=new Uint8Array(bottom.length);for(let y=0;y<height;y++)rgba.set(bottom.subarray(y*width*4,(y+1)*width*4),(height-y-1)*width*4);
   const error=gl.getError();if(error!==gl.NO_ERROR)throw Error(`WebGL error ${error}`);
  }finally{gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindTexture(gl.TEXTURE_2D,null);for(const f of fbos)gl.deleteFramebuffer(f);for(const t of textures)gl.deleteTexture(t);}
  const metrics=frameMetrics(rgba,width,height,{source:{rgba:sourceRGBA,width,height},previous});
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>{if(disposed)return reject(new DOMException('Renderer disposed','AbortError'));if(!blob)return reject(Error('PNG encoding failed'));resolve({blob,width,height,metrics,rgba,fixture:false});},'image/png'));
 }
 function checkTool(entry,{source,params={}}={}){if(disposed)throw Error('Renderer disposed');toolProgram(entry);const ref=entry.ref||`${entry.manifest.id}@${entry.manifest.version}`;return render({format:1,source:source?{w:source.width||64,h:source.height||64}:{w:64,h:64},seed:1,stack:[{tool:ref,params}],timeline:null},0,{source,tools:[entry],max_size:1600});}
 return {render,checkTool,dispose,canvas,maxTextureSize:limit,info:{version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(gl.RENDERER)}};
}
