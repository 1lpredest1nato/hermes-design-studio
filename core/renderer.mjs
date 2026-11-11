import {frameMetrics} from './metrics.mjs';
const vertex = `#version 300 es
out vec2 v_uv;
void main() { vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.0-1.0,0,1); }`;
const fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_time;
uniform float u_seed;
out vec4 outColor;
void main() { outColor=vec4(v_uv.x,v_uv.y,0.25+0.0*u_time+0.0*u_seed,1.0); }`;
/** P0 fixture only. Pure document/time inputs; no command engine or host imports. */
export function createRenderer(canvas) {
 const gl=canvas.getContext('webgl2',{preserveDrawingBuffer:true,alpha:false,antialias:false});
 if(!gl) throw new Error('WebGL2 unavailable; no renderer fallback enabled');
 let disposed=false;
 const shaders=[],programs=[];
 function compile(type,source) {
  const shader=gl.createShader(type); shaders.push(shader); gl.shaderSource(shader,source);gl.compileShader(shader);
  if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader)||'Shader compile failed');
  return shader;
 }
 let program;
 try {
  program=gl.createProgram();programs.push(program);gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program)||'Shader link failed');
 } catch(error) {for(const p of programs)gl.deleteProgram(p);for(const s of shaders)gl.deleteShader(s);throw error;}
 const vao=gl.createVertexArray();
 const limit=gl.getParameter(gl.MAX_TEXTURE_SIZE);
 function dispose() {if(disposed)return;disposed=true;gl.deleteVertexArray(vao);for(const p of programs)gl.deleteProgram(p);for(const s of shaders)gl.deleteShader(s);gl.getExtension('WEBGL_lose_context')?.loseContext();canvas.width=1;canvas.height=1;}
 function render(document,time=0,{kind='preview'}={}) {
  if(disposed)throw new Error('Renderer disposed');
  if(document?.format!==1)throw new Error('Unsupported project format');
  if(time!==0)throw new Error('P0 reserves u_time=0');
  let width=document.source?.w||640,height=document.source?.h||400;
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)throw new Error('Invalid dimensions');
  const cap=Math.min(limit,kind==='export'?4096:1600);
  if(kind==='export' && Math.max(width,height)>cap)throw new Error(`Export exceeds ${cap}px GPU/export limit`);
  const scale=Math.min(1,cap/Math.max(width,height));width=Math.max(1,Math.round(width*scale));height=Math.max(1,Math.round(height*scale));
  canvas.width=width;canvas.height=height;gl.viewport(0,0,width,height);gl.useProgram(program);gl.bindVertexArray(vao);
  gl.uniform1f(gl.getUniformLocation(program,'u_time'),0);gl.uniform1f(gl.getUniformLocation(program,'u_seed'),document.seed||0);
  gl.drawArrays(gl.TRIANGLES,0,3);
  const rgba=new Uint8Array(width*height*4);gl.readPixels(0,0,width,height,gl.RGBA,gl.UNSIGNED_BYTE,rgba);
  const error=gl.getError();if(error!==gl.NO_ERROR)throw new Error(`WebGL error ${error}`);
  const metrics=frameMetrics(rgba,width,height);
  // GPU work and readback are synchronous; only PNG encoding yields.
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>{
   if(disposed)return reject(new DOMException('Renderer disposed','AbortError'));
   if(!blob)return reject(new Error('PNG encoding failed'));
   resolve({blob,width,height,metrics,rgba,fixture:true});
  },'image/png'));
 }
 return {render,dispose,canvas,maxTextureSize:limit,info:{version:gl.getParameter(gl.VERSION),renderer:gl.getParameter(gl.RENDERER)}};
}
