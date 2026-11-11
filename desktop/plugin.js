// hermes/plugin.jsx
import { useEffect as useEffect2, useRef as useRef2, useState as useState2, useSyncExternalStore } from "react";
import { host as host2, useQuery as useQuery2, Button as Button2, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, TITLEBAR_AREAS } from "@hermes/plugin-sdk";

// core/metrics.mjs
function frameMetrics(rgba, width, height, { source, previous } = {}) {
  if (rgba.length !== width * height * 4 || !width || !height) throw new Error("Invalid RGBA dimensions");
  const count = width * height;
  const lumas = new Float64Array(count);
  let sum = 0, square = 0, shadows = 0, highlights = 0, gradients = 0, edges = 0;
  const histogram = /* @__PURE__ */ new Map();
  for (let i = 0; i < count; i++) {
    const at = i * 4;
    const value = (0.2126 * rgba[at] + 0.7152 * rgba[at + 1] + 0.0722 * rgba[at + 2]) / 255;
    lumas[i] = value;
    sum += value;
    square += value * value;
    shadows += value <= 0.01;
    highlights += value >= 0.99;
    const hex = "#" + [rgba[at], rgba[at + 1], rgba[at + 2]].map((v) => (Math.min(15, v >> 4) * 17).toString(16).padStart(2, "0")).join("");
    histogram.set(hex, (histogram.get(hex) || 0) + 1);
    if (i % width) {
      gradients += Math.abs(value - lumas[i - 1]);
      edges++;
    }
    if (i >= width) {
      gradients += Math.abs(value - lumas[i - width]);
      edges++;
    }
  }
  const mean = sum / count, std = Math.sqrt(Math.max(0, square / count - mean * mean));
  function difference(frame) {
    if (!frame || frame.width !== width || frame.height !== height || frame.rgba?.length !== rgba.length) return null;
    let total = 0;
    for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c++) total += Math.abs(rgba[i + c] - frame.rgba[i + c]);
    return total / (count * 3 * 255);
  }
  return {
    width,
    height,
    mean_luma: mean,
    std_luma: std,
    shadow_clipping_pct: shadows / count * 100,
    highlight_clipping_pct: highlights / count * 100,
    detail_density: edges ? gradients / edges : 0,
    dominant_colors: [...histogram].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([hex, n]) => ({ hex, fraction: n / count })),
    nearly_uniform: std < 5e-3,
    difference_source: difference(source),
    difference_previous: difference(previous),
    metrics_scope: "sRGB uncomposited RGB; differences mean absolute RGB /255; unavailable or mismatched comparison is null"
  };
}

// core/renderer.mjs
var vertex = `#version 300 es
out vec2 v_uv;
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);v_uv=p;gl_Position=vec4(p*2.0-1.0,0,1);}`;
var header = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time;
uniform float u_seed;
in vec2 v_uv;
out vec4 outColor;
`;
var copy = "void main(){outColor=texture(u_input,v_uv);}";
var blending = `uniform sampler2D u_effect;
uniform float u_opacity;
uniform int u_blend;
void main(){vec4 b=texture(u_input,v_uv),s=texture(u_effect,v_uv);vec3 c=s.rgb;
if(u_blend==1)c=b.rgb*s.rgb;
if(u_blend==2)c=1.0-(1.0-b.rgb)*(1.0-s.rgb);
if(u_blend==3)c=mix(2.0*b.rgb*s.rgb,1.0-2.0*(1.0-b.rgb)*(1.0-s.rgb),step(vec3(0.5),b.rgb));
outColor=vec4(mix(b.rgb,c,u_opacity),mix(b.a,s.a,u_opacity));}`;
function shaderHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}
function parameterDeclarations(params) {
  return params.map((p) => {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(p.name)) throw Error("Invalid uniform name");
    const type = { float: "float", int: "int", bool: "bool", color: "vec3", enum: "int" }[p.type];
    if (!type) throw Error("Invalid parameter type");
    return `uniform ${type} p_${p.name};`;
  }).join("\n");
}
function linearColor(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw Error("Invalid color uniform");
  return [1, 3, 5].map((i) => {
    const s = parseInt(hex.slice(i, i + 2), 16) / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}
var present = "void main(){outColor=texture(u_input,vec2(v_uv.x,1.0-v_uv.y));}";
function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, alpha: true, premultipliedAlpha: false, antialias: false });
  if (!gl) throw new Error("WebGL2 unavailable; no renderer fallback enabled");
  const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE), vao = gl.createVertexArray(), cache = /* @__PURE__ */ new Map();
  let disposed = false;
  function compile(source) {
    const program2 = gl.createProgram(), shaders = [];
    try {
      for (const [type, text] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, header + source]]) {
        const s = gl.createShader(type);
        shaders.push(s);
        gl.shaderSource(s, text);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error("GLSL compile: " + gl.getShaderInfoLog(s));
        gl.attachShader(program2, s);
      }
      gl.linkProgram(program2);
      if (!gl.getProgramParameter(program2, gl.LINK_STATUS)) throw Error("GLSL link: " + gl.getProgramInfoLog(program2));
      return program2;
    } catch (e) {
      gl.deleteProgram(program2);
      throw e;
    } finally {
      for (const s of shaders) gl.deleteShader(s);
    }
  }
  function program(key, source) {
    const k = key + "|" + shaderHash(source) + "|" + source;
    if (cache.has(k)) {
      const p2 = cache.get(k);
      cache.delete(k);
      cache.set(k, p2);
      return p2;
    }
    const p = compile(source);
    cache.set(k, p);
    if (cache.size > 64) {
      const oldest = cache.keys().next().value;
      gl.deleteProgram(cache.get(oldest));
      cache.delete(oldest);
    }
    return p;
  }
  function toolProgram(entry) {
    const m = entry.manifest;
    if (m?.format !== 1 || m.kind && m.kind !== "shader" || typeof entry.shader !== "string") throw Error("Unsupported tool format/kind");
    return program(`${m.id}@${m.version}`, parameterDeclarations(m.params || []) + "\n#line 1\n" + entry.shader);
  }
  function uniforms(p, entry, values) {
    for (const spec of entry.manifest.params || []) {
      const value = values[spec.name] ?? spec.default, loc = gl.getUniformLocation(p, "p_" + spec.name);
      switch (spec.type) {
        case "float":
          if (!Number.isFinite(value)) throw Error("Invalid float parameter " + spec.name);
          gl.uniform1f(loc, value);
          break;
        case "int":
          if (!Number.isInteger(value)) throw Error("Invalid int parameter " + spec.name);
          gl.uniform1i(loc, value);
          break;
        case "bool":
          if (typeof value !== "boolean") throw Error("Invalid bool parameter " + spec.name);
          gl.uniform1i(loc, value ? 1 : 0);
          break;
        case "enum": {
          const options = spec.options || spec.values || [];
          const index = options.findIndex((o) => (typeof o === "object" ? o.value : o) === value);
          if (index < 0) throw Error("Invalid enum parameter " + spec.name);
          gl.uniform1i(loc, index);
          break;
        }
        case "color":
          gl.uniform3fv(loc, linearColor(value));
          break;
      }
    }
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const p of cache.values()) gl.deleteProgram(p);
    cache.clear();
    gl.deleteVertexArray(vao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.width = 1;
    canvas.height = 1;
  }
  function render(doc, time = 0, { kind = "preview", max_size = 1600, source, tools = [], previous } = {}) {
    if (disposed) throw Error("Renderer disposed");
    if (doc?.format !== 1) throw Error("Unsupported project format");
    if (time !== 0) throw Error("Static renderer reserves u_time=0");
    if (!["preview", "export"].includes(kind)) throw Error("Invalid render kind");
    let width = doc.source?.w ?? source?.width ?? 640, height = doc.source?.h ?? source?.height ?? 400;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw Error("Invalid dimensions");
    if (!Number.isFinite(max_size) || max_size < 1) throw Error("Invalid preview max_size");
    const cap = Math.min(limit, kind === "export" ? 4096 : Math.min(1600, Math.floor(max_size)));
    if (kind === "export" && Math.max(width, height) > cap) throw Error(`Export exceeds ${cap}px GPU/export limit`);
    const scale = Math.min(1, cap / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    let input;
    if (source?.rgba) {
      if (!Number.isInteger(source.width) || !Number.isInteger(source.height) || source.width < 1 || source.height < 1 || source.rgba.length !== source.width * source.height * 4) throw Error("Invalid source RGBA dimensions");
      input = source;
    } else if (source) {
      const c = document.createElement("canvas");
      c.width = width;
      c.height = height;
      const cx = c.getContext("2d", { willReadFrequently: true });
      cx.drawImage(source, 0, 0, width, height);
      input = { rgba: cx.getImageData(0, 0, width, height).data, width, height };
    } else if (doc.source?.asset) throw Error("Project asset source was not supplied");
    else {
      const rgba2 = new Uint8Array(width * height * 4);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        rgba2.set([Math.round((x + 0.5) / width * 255), Math.round((1 - (y + 0.5) / height) * 255), 64, 255], i);
      }
      input = { rgba: rgba2, width, height };
    }
    if (input.width > limit || input.height > limit) throw Error(`Source exceeds ${limit}px GPU texture limit`);
    const textures = [], fbos = [];
    function texture(w, h, data) {
      const t = gl.createTexture();
      textures.push(t);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
      return t;
    }
    function target() {
      const t = texture(width, height, null), f = gl.createFramebuffer();
      fbos.push(f);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw Error("Incomplete RGBA8 framebuffer");
      return { t, f };
    }
    function draw(p, t, f, setup = () => {
    }) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.viewport(0, 0, width, height);
      gl.useProgram(p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(gl.getUniformLocation(p, "u_input"), 0);
      gl.uniform2f(gl.getUniformLocation(p, "u_resolution"), width, height);
      gl.uniform1f(gl.getUniformLocation(p, "u_time"), 0);
      gl.uniform1f(gl.getUniformLocation(p, "u_seed"), doc.seed || 0);
      setup();
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    let rgba, sourceRGBA;
    try {
      canvas.width = width;
      canvas.height = height;
      gl.disable(gl.BLEND);
      gl.disable(gl.DITHER);
      gl.bindVertexArray(vao);
      const uploaded = texture(input.width, input.height, input.rgba);
      const a = target();
      draw(program("copy", copy), uploaded, a.f);
      sourceRGBA = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, sourceRGBA);
      let current = a;
      if ((doc.stack || []).some((n) => n.enabled !== false && (n.opacity ?? 1) !== 0)) {
        const b = target(), effect = target();
        for (const node of doc.stack || []) {
          if (node.enabled === false || (node.opacity ?? 1) === 0) continue;
          const entry = tools.find((e) => (e.ref || `${e.manifest.id}@${e.manifest.version}`) === node.tool);
          if (!entry) throw Error("Unknown tool " + node.tool);
          const opacity = node.opacity ?? 1, blend = node.blend ?? "normal";
          if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1 || !["normal", "multiply", "screen", "overlay"].includes(blend)) throw Error("Invalid node opacity/blend");
          const p = toolProgram(entry);
          draw(p, current.t, effect.f, () => uniforms(p, entry, node.params || {}));
          const next = current === a ? b : a, bp = program("blend", blending);
          draw(bp, current.t, next.f, () => {
            gl.activeTexture(gl.TEXTURE1);
            gl.bindTexture(gl.TEXTURE_2D, effect.t);
            gl.uniform1i(gl.getUniformLocation(bp, "u_effect"), 1);
            gl.uniform1f(gl.getUniformLocation(bp, "u_opacity"), opacity);
            gl.uniform1i(gl.getUniformLocation(bp, "u_blend"), ["normal", "multiply", "screen", "overlay"].indexOf(blend));
          });
          current = next;
        }
      }
      draw(program("present", present), current.t, null);
      const bottom = new Uint8Array(width * height * 4);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, bottom);
      rgba = new Uint8Array(bottom.length);
      for (let y = 0; y < height; y++) rgba.set(bottom.subarray(y * width * 4, (y + 1) * width * 4), (height - y - 1) * width * 4);
      const error = gl.getError();
      if (error !== gl.NO_ERROR) throw Error(`WebGL error ${error}`);
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      for (const f of fbos) gl.deleteFramebuffer(f);
      for (const t of textures) gl.deleteTexture(t);
    }
    const metrics = frameMetrics(rgba, width, height, { source: { rgba: sourceRGBA, width, height }, previous });
    return new Promise((resolve, reject) => canvas.toBlob((blob) => {
      if (disposed) return reject(new DOMException("Renderer disposed", "AbortError"));
      if (!blob) return reject(Error("PNG encoding failed"));
      resolve({ blob, width, height, metrics, rgba, fixture: false });
    }, "image/png"));
  }
  function checkTool(entry, { source, params = {} } = {}) {
    if (disposed) throw Error("Renderer disposed");
    toolProgram(entry);
    const ref = entry.ref || `${entry.manifest.id}@${entry.manifest.version}`;
    return render({ format: 1, source: source ? { w: source.width || 64, h: source.height || 64 } : { w: 64, h: 64 }, seed: 1, stack: [{ tool: ref, params }], timeline: null }, 0, { source, tools: [entry], max_size: 1600 });
  }
  return { render, checkTool, dispose, canvas, maxTextureSize: limit, info: { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER) } };
}

// hermes/assets.mjs
async function loadAsset(rest, asset, signal) {
  const match = /^assets\/([a-f0-9]{64})\.png$/.exec(asset || "");
  if (!match) throw new Error("Invalid content-addressed asset reference");
  const alive = () => {
    if (signal.aborted) throw new DOMException("Asset read cancelled", "AbortError");
  };
  const chunks = [];
  let offset = 0, total = null, mime = "image/png";
  do {
    alive();
    const part = await rest(`/assets/read?sha=${match[1]}&offset=${offset}&length=1048576`);
    alive();
    if (!Number.isSafeInteger(part.total) || part.total <= 0 || part.total > 1024 * 1024 * 1024 || part.offset !== offset || total !== null && part.total !== total) throw new Error("Invalid asset read response");
    total = part.total;
    mime = part.mime;
    const bytes = Uint8Array.from(atob(part.base64), (c) => c.charCodeAt(0));
    if (!bytes.length || bytes.length > 1048576 || part.bytes !== bytes.length || offset + bytes.length > total) throw new Error("Invalid asset chunk length");
    chunks.push(bytes);
    offset += bytes.length;
  } while (offset < total);
  const blob = new Blob(chunks, { type: mime });
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  alive();
  const hash = [...new Uint8Array(digest)].map((n) => n.toString(16).padStart(2, "0")).join("");
  if (hash !== match[1]) throw new Error("Asset content hash mismatch");
  return blob;
}

// hermes/service.mjs
function createService(ctx, renderer, { runId, build, diagnosticsRunner }) {
  const controller = new AbortController();
  const handled = /* @__PURE__ */ new Set(), inflight = /* @__PURE__ */ new Set();
  let pageCount = 0, cacheRevision = null;
  let tail = Promise.resolve();
  let snapshot = { run_id: runId, build, detached_canvas: true, page_active: false, status: "ready" };
  const listeners = /* @__PURE__ */ new Set();
  const assets = /* @__PURE__ */ new Map();
  const frames = /* @__PURE__ */ new Map();
  const alive = () => {
    if (controller.signal.aborted) throw new DOMException("Plugin unloaded", "AbortError");
  };
  const publish = (change) => {
    snapshot = { ...snapshot, ...change };
    for (const fn of listeners) fn();
  };
  async function rest(path, opts) {
    alive();
    const value = await ctx.rest(path, opts);
    alive();
    return value;
  }
  function metadata(extra = {}) {
    return { run_id: runId, build, page_active: pageCount > 0, detached_canvas: true, at: (/* @__PURE__ */ new Date()).toISOString(), ...extra };
  }
  async function report(fields) {
    const update = { ...metadata(), ...fields };
    return rest("/report", { method: "POST", body: { ...update, runs: { [runId]: update } } });
  }
  async function renderOne(request, via, cache2 = false) {
    alive();
    const doc = request.document;
    const options = {
      kind: request.kind === "check" ? "preview" : request.kind || "preview",
      max_size: request.max_size,
      ...request.kind === "check" ? { toolOverride: request.entry, params: request.params, fixture: request.fixture !== false, comparison: true } : {}
    };
    const frame = await projectFrame(doc, options);
    alive();
    return persistFrame(request, frame, via, cache2);
  }
  async function persistFrame(request, frame, via, cache2) {
    const doc = request.document;
    const bytes = await frame.blob.arrayBuffer();
    alive();
    const meta = metadata({
      request_id: request.request_id,
      kind: request.kind || "preview",
      revision: doc.revision,
      project_id: doc.id,
      via,
      width: frame.width,
      height: frame.height,
      metrics: frame.metrics,
      fixture: !doc.source || frame.fixture === true || request.kind === "check" && request.fixture !== false,
      u_time: 0,
      ...request.kind === "check" ? { shader_sha: request.shader_sha } : {}
    });
    const path = cache2 ? `/preview/cache?revision=${doc.revision}&meta=${encodeURIComponent(JSON.stringify(meta))}` : `/render/response?id=${encodeURIComponent(request.request_id)}&meta=${encodeURIComponent(JSON.stringify(meta))}`;
    const receipt = await rest(path, { method: "POST", upload: { filename: "studio-preview.png", contentType: "image/png", bytes }, timeoutMs: 15e3 });
    const observation = { ...meta, request_id: request.request_id || null, receipt, png_bytes: bytes.byteLength };
    await report({ service: observation, renders: { [request.request_id || `cache-${doc.revision}`]: observation } });
    publish({ last: meta, status: "rendered" });
    return receipt;
  }
  function enqueue(fn) {
    const result = tail.then(() => {
      alive();
      return fn();
    });
    tail = result.catch(() => {
    });
    return result;
  }
  async function projectFrame(document2, options = {}) {
    alive();
    if (options.toolOverride) {
      const entry = options.toolOverride, manifest = entry.manifest;
      const ref = entry.ref || `${manifest.id}@${manifest.version}`;
      document2 = {
        ...document2,
        source: options.fixture ? null : document2.source,
        stack: [{
          uid: "draft-preview",
          tool: ref,
          enabled: true,
          opacity: 1,
          blend: "normal",
          params: { ...Object.fromEntries((manifest.params || []).map((p) => [p.name, p.default])), ...options.params || {} }
        }]
      };
    }
    const tools = options.toolOverride ? [options.toolOverride] : options.tools || (document2.stack?.length ? (await rest("/catalog")).tools : []);
    alive();
    let source = options.source;
    if (!source && document2.source?.asset) {
      const key = document2.source.asset;
      if (!assets.has(key)) {
        const blob = await loadAsset(rest, key, controller.signal);
        alive();
        const bitmap = await createImageBitmap(blob);
        if (controller.signal.aborted) {
          bitmap.close();
          alive();
        }
        if (Math.max(bitmap.width, bitmap.height) > renderer.maxTextureSize) {
          bitmap.close();
          throw new Error("Source exceeds GPU texture limit");
        }
        assets.set(key, bitmap);
        if (assets.size > 2) {
          const oldest = assets.keys().next().value;
          assets.get(oldest).close();
          assets.delete(oldest);
        }
      }
      source = assets.get(key);
    }
    const track = !options.comparison && !options.toolOverride && options.kind !== "export";
    const old = frames.get(document2.id);
    const previous = options.previous || (track && old ? old.revision === document2.revision ? old.prior : old.frame : void 0);
    const frame = await renderer.render(document2, 0, { ...options, tools, source, previous });
    alive();
    if (track && frame.rgba instanceof Uint8Array) {
      if (!old || old.revision !== document2.revision) frames.set(document2.id, { revision: document2.revision, prior: old?.frame, frame: { rgba: frame.rgba, width: frame.width, height: frame.height } });
      if (frames.size > 2) frames.delete(frames.keys().next().value);
    }
    return frame;
  }
  async function accept(data, via = "poll") {
    if (controller.signal.aborted) return;
    const work = [];
    for (const request of data.requests || data.pending || []) {
      if (handled.has(request.request_id) || inflight.has(request.request_id)) continue;
      inflight.add(request.request_id);
      work.push(enqueue(() => renderOne(request, via)).then(() => handled.add(request.request_id)).catch(async (error) => {
        if (controller.signal.aborted) return;
        await rest(`/render/error?id=${encodeURIComponent(request.request_id)}`, { method: "POST", body: { error: String(error), shader_sha: request.shader_sha } });
        handled.add(request.request_id);
        publish({ status: "error", error: String(error) });
        await report({ render_errors: { [request.request_id]: metadata({ error: String(error), shader_sha: request.shader_sha }) } });
      }).finally(() => inflight.delete(request.request_id)));
    }
    await Promise.all(work);
  }
  function cache(document2) {
    const key = `${document2.id}:${document2.revision}`;
    if (controller.signal.aborted || cacheRevision === key) return Promise.resolve();
    cacheRevision = key;
    return enqueue(() => renderOne({ document: document2, kind: "preview" }, "poll", true)).catch((error) => {
      cacheRevision = null;
      if (!controller.signal.aborted) {
        publish({ status: "error", error: String(error) });
        throw error;
      }
    });
  }
  async function waitResult(id) {
    const deadline = Date.now() + 1e4;
    do {
      const result = await rest(`/render/result?id=${encodeURIComponent(id)}`);
      if (!result.pending) {
        if (result.error) throw new Error(result.error);
        return result;
      }
      await new Promise((resolve, reject) => {
        const cancel = () => {
          clearTimeout(timer);
          reject(new DOMException("Plugin unloaded", "AbortError"));
        };
        const timer = setTimeout(() => {
          controller.signal.removeEventListener("abort", cancel);
          resolve();
        }, 100);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
      alive();
    } while (Date.now() < deadline);
    throw new Error("Renderer response timed out");
  }
  async function checkDraft(entry, options = {}) {
    const request = await rest("/drafts/check", { method: "POST", body: { id: entry.manifest.id, expected_shader_sha: entry.expected_shader_sha, expected_manifest_sha: entry.expected_manifest_sha, fixture: options.fixture !== false, params: options.params || {} } });
    await accept({ requests: [request] }, "manual");
    const check2 = await waitResult(request.request_id);
    const frame = await enqueue(() => projectFrame(request.document, { toolOverride: request.entry, params: request.params, fixture: request.fixture !== false, kind: "preview", comparison: true }));
    return { ...frame, frame, check: check2, request, entry: request.entry };
  }
  async function saveLibrary(document2) {
    const request = await rest("/render/request", { method: "POST", body: { kind: "export", base_revision: document2.revision, project_id: document2.id } });
    if (request.document.id !== document2.id || request.document.revision !== document2.revision) throw new Error("Project changed before export; refresh and retry");
    await accept({ requests: [request] }, "manual");
    return waitResult(request.request_id);
  }
  async function diagnostics() {
    if (!diagnosticsRunner) throw new Error("Diagnostic runner unavailable");
    const catalog = await rest("/catalog");
    return enqueue(async () => {
      const result = await diagnosticsRunner(renderer, catalog.tools);
      alive();
      const stamped = { ...result, ...metadata() };
      await rest("/diagnostics", { method: "POST", body: stamped });
      return stamped;
    });
  }
  function dispose() {
    if (controller.signal.aborted) return;
    controller.abort();
    renderer.dispose();
    for (const bitmap of assets.values()) bitmap.close();
    assets.clear();
    frames.clear();
    listeners.clear();
  }
  ctx.onDispose(dispose);
  return {
    accept,
    cache,
    report,
    rest,
    renderer,
    signal: controller.signal,
    dispose,
    render: (document2, time = 0, options) => enqueue(() => renderer.render(document2, time, options)),
    renderProject: (document2, options = {}) => enqueue(async () => {
      const frame = await projectFrame(document2, options);
      if ((options.kind || "preview") === "preview" && !options.comparison && !options.toolOverride) {
        await persistFrame({ document: document2, kind: "preview" }, frame, "ui", true);
        cacheRevision = `${document2.id}:${document2.revision}`;
      }
      return frame;
    }),
    checkDraft,
    saveLibrary,
    diagnostics,
    getState: () => rest("/state"),
    getSnapshot: () => snapshot,
    subscribe: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    page(active) {
      pageCount = Math.max(0, pageCount + (active ? 1 : -1));
      publish({ page_active: pageCount > 0 });
    },
    metadata
  };
}

// hermes/upload.mjs
var CHUNK = 4 * 1024 * 1024;
function check(signal) {
  if (signal.aborted) throw new DOMException("Upload cancelled", "AbortError");
}
async function uploadChunks(blob, { rest, signal, onProgress = () => {
} }) {
  check(signal);
  const bytes = await blob.arrayBuffer();
  check(signal);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  check(signal);
  const sha256 = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, "0")).join("");
  const id = crypto.randomUUID().replaceAll("-", "");
  const total = Math.ceil(bytes.byteLength / CHUNK);
  if (!total) throw new Error("Empty upload");
  let receipt;
  for (let index = 0; index < total; index++) {
    check(signal);
    receipt = await rest(`/assets/upload?id=${id}&index=${index}&total=${total}&sha256=${sha256}`, {
      method: "POST",
      upload: { filename: `part-${index}.bin`, contentType: "application/octet-stream", bytes: bytes.slice(index * CHUNK, (index + 1) * CHUNK) },
      timeoutMs: 3e4
    });
    check(signal);
    await onProgress({ id, index, total, bytes_received: Math.min((index + 1) * CHUNK, bytes.byteLength), bytes_total: bytes.byteLength, receipt, sha256 });
    check(signal);
  }
  const actual = receipt.sha256 || receipt.asset?.sha256;
  if (actual !== sha256) throw new Error(`Backend SHA mismatch or missing SHA: ${actual || "missing"}`);
  return { id, sha256, sha256_match: true, bytes: bytes.byteLength, total, receipt };
}
async function makeUploadProbe(canvas, signal) {
  check(signal);
  canvas.width = 2560;
  canvas.height = 2400;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let offset = 0; offset < image.data.length; offset += 65536) {
    check(signal);
    crypto.getRandomValues(image.data.subarray(offset, Math.min(offset + 65536, image.data.length)));
  }
  ctx.putImageData(image, 0, 0);
  const blob = await new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("Probe PNG encoding failed")), "image/png"));
  check(signal);
  if (blob.size < 20 * 1024 * 1024) throw new Error(`Probe PNG ${blob.size} bytes below 20MiB; not counted`);
  return blob;
}

// hermes/studio-page.jsx
import { useEffect, useRef, useState } from "react";
import { Button, Input, Textarea, KEYBINDS_AREA, host, useQuery } from "@hermes/plugin-sdk";

// hermes/controls.jsx
function paramValue(param, raw) {
  if (param.type === "bool") return Boolean(raw);
  if (param.type === "float" || param.type === "int") {
    if (raw === "" || !Number.isFinite(Number(raw))) throw new Error("Enter a finite number");
    return Number(raw);
  }
  return String(raw);
}
function assertLive(signal) {
  if (signal.aborted) throw new DOMException("Import cancelled", "AbortError");
}
async function importImage(file, { signal, maxTextureSize, decode, show, encode, upload, send }) {
  assertLive(signal);
  let bitmap;
  try {
    bitmap = await decode(file);
    assertLive(signal);
    if (Math.max(bitmap.width, bitmap.height) > maxTextureSize) throw new Error(`Image exceeds GPU texture limit ${maxTextureSize}px (${bitmap.width} \xD7 ${bitmap.height}). Resize the image before importing.`);
    show({ blob: file, width: bitmap.width, height: bitmap.height, local: true });
    const png = await encode(bitmap);
    assertLive(signal);
    const result = await upload(png);
    assertLive(signal);
    const asset = result.receipt?.asset;
    if (typeof asset !== "string") throw new Error("Upload completed without an asset receipt");
    await send([{ type: "set_source", source: { asset, w: bitmap.width, h: bitmap.height } }]);
    assertLive(signal);
    return result;
  } finally {
    bitmap?.close();
  }
}
function paramDefaults(params = []) {
  return Object.fromEntries(params.map((p) => [p.name, p.default]));
}
function createCommandChannel({
  rest,
  getDocument,
  onDocument,
  refresh,
  onConflict = () => {
  },
  now = () => Date.now(),
  wait = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
  let closed = false, running = false, last = -Infinity;
  const pending = [];
  async function drain(initialSnapshot) {
    if (running) return;
    running = true;
    while (pending.length && !closed) {
      const job = pending.shift();
      try {
        const pause = Math.max(0, 1e3 / 15 - (now() - last));
        if (pause) await wait(pause);
        if (closed) throw new Error("Command channel closed");
        const snapshot = !pause && initialSnapshot ? initialSnapshot : getDocument();
        initialSnapshot = void 0;
        if (snapshot.id !== job.projectId) throw Object.assign(new Error("HTTP 409 project identity conflict"), { status: 409 });
        const body = { ...job.body, project_id: job.projectId, base_revision: snapshot.revision };
        last = now();
        const result = await rest(job.path, { method: "POST", body });
        if (closed) throw new Error("Command channel closed");
        onDocument(result.document);
        job.listeners.forEach((p) => p.resolve(result));
      } catch (error) {
        if (!closed && (error.status === 409 || /409|revision.*conflict/i.test(String(error)))) {
          try {
            const state = error.document ? { document: error.document } : await refresh();
            if (!closed) onDocument(state.document);
          } catch {
          }
          if (!closed) onConflict();
          pending.splice(0).forEach((j) => j.listeners.forEach((p) => p.reject(error)));
        }
        job.listeners.forEach((p) => p.reject(error));
      }
    }
    running = false;
  }
  function enqueue(path, body, gesture) {
    if (closed) return Promise.reject(new Error("Command channel closed"));
    return new Promise((resolve, reject) => {
      const snapshot = getDocument(), projectId = snapshot.id;
      const tail = pending.at(-1);
      if (gesture && tail?.gesture === gesture && tail.path === path && tail.projectId === projectId) {
        tail.body = body;
        tail.listeners.push({ resolve, reject });
      } else pending.push({ path, body, gesture, projectId, listeners: [{ resolve, reject }] });
      void drain(snapshot);
    });
  }
  return {
    send(commands, gesture_id) {
      return enqueue("/commands", { commands, ...gesture_id ? { gesture_id } : {} }, gesture_id);
    },
    action(path, body = {}) {
      return enqueue(path, body);
    },
    dispose() {
      closed = true;
      pending.splice(0).forEach((j) => j.listeners.forEach((p) => p.reject(new Error("Command channel closed"))));
    }
  };
}

// hermes/studio-page.jsx
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
var TYPES = ["float", "int", "bool", "color", "enum"];
var initialDraft = { name: "My tool", description: "", shader: "void main() {\n  outColor = texture(u_input, v_uv);\n}", params: [] };
var CSS = `
.hds{height:100%;min-height:420px;display:flex;flex-direction:column;overflow:hidden;color:var(--ui-text-primary);font-size:12px;background:var(--ui-bg-editor)}
.hds *{box-sizing:border-box}.hds h1,.hds h2,.hds h3,.hds p{margin:0}.hds h1{font-size:14px;font-weight:600;letter-spacing:-.025em}.hds h2{font-size:12px;font-weight:600}.hds h3{font-size:12px;font-weight:500}.hds button,.hds input,.hds select,.hds textarea{font:inherit}.hds button{cursor:pointer}.hds button:disabled{cursor:default;opacity:.45}.hds :focus-visible{outline:2px solid var(--ui-accent);outline-offset:2px}.hds input[type=range],.hds input[type=checkbox]{accent-color:var(--ui-accent)}
.hds .ds-top{display:flex;align-items:center;gap:16px;min-height:60px;padding:12px 18px;border-bottom:1px solid var(--ui-stroke-secondary);flex-wrap:wrap}.hds .ds-brand{margin-right:auto;display:grid;gap:4px}.hds .ds-eyebrow{font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--ui-text-tertiary)}.hds .ds-muted{color:var(--ui-text-tertiary);line-height:1.55}.hds .ds-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.hds .ds-space{justify-content:space-between}.hds .ds-columns{display:grid;grid-template-columns:232px minmax(240px,1fr) 320px;flex:1;min-height:0;overflow:auto}.hds .ds-panel{min-height:0;overflow:auto;padding:16px;display:flex;flex-direction:column;gap:16px}.hds .ds-left{border-right:1px solid var(--ui-stroke-secondary)}.hds .ds-right{border-left:1px solid var(--ui-stroke-secondary)}.hds .ds-heading{display:flex;justify-content:space-between;align-items:center;gap:8px}.hds .ds-count{font-variant-numeric:tabular-nums;color:var(--ui-text-tertiary)}
.hds .ds-empty{padding:24px 10px;display:grid;gap:8px;text-align:center;line-height:1.6;color:var(--ui-text-tertiary);border:1px dashed var(--ui-stroke-secondary);border-radius:6px}.hds .ds-stack{display:grid;gap:6px}.hds .ds-node{padding:10px;border:1px solid var(--ui-stroke-secondary);border-radius:5px;display:grid;gap:8px;background:var(--ui-bg-editor)}.hds .ds-node[data-selected=true]{border-color:var(--ui-accent);background:var(--ui-bg-card)}.hds .ds-node-title{border:0;padding:0;background:none;color:var(--ui-text-primary);text-align:left;flex:1;min-width:0}.hds .ds-node-title span{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hds .ds-number{font-size:10px;color:var(--ui-text-tertiary);font-variant-numeric:tabular-nums}.hds .ds-select{border:1px solid var(--ui-stroke-secondary);background:var(--ui-bg-input);color:var(--ui-text-primary);padding:5px 7px;border-radius:4px;min-width:0;max-width:100%}.hds .ds-field{display:grid;gap:7px;min-width:0}.hds .ds-field-head{display:flex;justify-content:space-between;gap:8px}.hds .ds-value{color:var(--ui-text-secondary);font-variant-numeric:tabular-nums}.hds .ds-divider{height:1px;background:var(--ui-stroke-secondary);flex-shrink:0}.hds .ds-fields{display:grid;gap:18px}.hds .ds-canvas-column{display:flex;flex-direction:column;min-width:0;min-height:360px}.hds .ds-canvas-toolbar{padding:10px 14px;display:flex;align-items:center;justify-content:space-between;gap:8px;border-bottom:1px solid var(--ui-stroke-secondary);flex-wrap:wrap}.hds .ds-viewport{flex:1;min-height:260px;position:relative;overflow:auto;background:var(--ui-bg-secondary);display:grid;place-items:center;padding:24px}.hds .ds-viewport[data-drag=true]{outline:2px dashed var(--ui-accent);outline-offset:-8px}.hds .ds-canvas-wrap{width:100%;height:100%;min-height:200px;position:relative;display:grid;place-items:center}.hds canvas{display:block}.hds .ds-canvas-empty{position:absolute;inset:0;display:grid;place-content:center;text-align:center;gap:10px;pointer-events:none;color:var(--ui-text-tertiary)}.hds .ds-canvas-foot{padding:10px 14px;border-top:1px solid var(--ui-stroke-secondary);display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--ui-text-tertiary)}.hds .ds-alert{padding:10px 16px;border-bottom:1px solid var(--ui-stroke-secondary);color:var(--ui-text-primary);background:var(--ui-bg-card);white-space:pre-wrap;line-height:1.6}.hds .ds-alert button{float:right}.hds .ds-card{padding:12px;border:1px solid var(--ui-stroke-secondary);border-radius:5px;display:grid;gap:8px}.hds .ds-tabs{display:flex;gap:4px;border-bottom:1px solid var(--ui-stroke-secondary);padding-bottom:8px}.hds .ds-tabs button[aria-selected=true]{color:var(--ui-accent);background:var(--ui-bg-card)}.hds .ds-bottom{margin-top:auto;padding-top:16px;border-top:1px solid var(--ui-stroke-secondary)}.hds .ds-mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:11px;line-height:1.6}.hds .ds-code{display:flex;min-height:200px}.hds .ds-lines{padding:8px 8px 8px 0;text-align:right;color:var(--ui-text-quaternary);user-select:none;white-space:pre;line-height:1.6;font:11px/1.6 ui-monospace,monospace}.hds .ds-code textarea{width:100%;min-height:200px;white-space:pre;tab-size:2;resize:vertical;font:11px/1.6 ui-monospace,monospace}.hds .ds-table-wrap{overflow:auto}.hds table{width:100%;border-collapse:collapse;text-align:left;font-size:11px}.hds th,.hds td{padding:6px 4px;border-bottom:1px solid var(--ui-stroke-secondary);vertical-align:top}.hds th{font-weight:500;color:var(--ui-text-tertiary)}.hds td input{min-width:65px;width:100%}.hds .ds-mini-preview{height:150px;overflow:hidden;position:relative}.hds .ds-upload{display:grid;gap:6px}.hds progress{width:100%;accent-color:var(--ui-accent)}
.hds[data-theme=minimal]{--hds-bg:#f5f5f2;--hds-fg:#20211f;--hds-muted:#73756f;--hds-line:#d9dbd4;--hds-accent:#3e594b;--ui-bg-editor:var(--hds-bg);--ui-bg-secondary:#eaece6;--ui-bg-input:#fafbf8;--ui-bg-card:#ebeee7;--ui-bg-quaternary:#e5e8e0;--ui-text-primary:var(--hds-fg);--ui-text-secondary:#50554b;--ui-text-tertiary:var(--hds-muted);--ui-text-quaternary:#95998f;--ui-stroke-secondary:var(--hds-line);--ui-accent:var(--hds-accent)}
@media(max-width:1050px){.hds .ds-columns{grid-template-columns:195px minmax(220px,1fr) 285px}.hds .ds-panel{padding:12px}.hds .ds-top{gap:10px}}@media(max-width:760px){.hds .ds-columns{grid-template-columns:180px minmax(300px,1fr) 280px}.hds .ds-top{padding:10px}.hds .ds-viewport{padding:12px}}
`;
function Action({ children, ...props }) {
  return /* @__PURE__ */ jsx(Button, { type: "button", variant: "ghost", size: "sm", ...props, children });
}
function Message({ children }) {
  return /* @__PURE__ */ jsx("div", { className: "ds-empty", children });
}
function NativeSelect({ label, value, onChange, children, ...props }) {
  return /* @__PURE__ */ jsx("select", { "aria-label": label, className: "ds-select", value, onChange: (e) => onChange(e.target.value), ...props, children });
}
function Parameter({ param, value, onChange, onGesture }) {
  const gesture = useRef(null);
  const current = value ?? param.default;
  function change(raw) {
    try {
      onChange(paramValue(param, raw), gesture.current);
    } catch {
    }
  }
  const begin = () => {
    gesture.current = crypto.randomUUID();
    onGesture?.(gesture.current);
  };
  const end = () => {
    gesture.current = null;
  };
  return /* @__PURE__ */ jsxs("label", { className: "ds-field", children: [
    /* @__PURE__ */ jsxs("span", { className: "ds-field-head", children: [
      /* @__PURE__ */ jsx("span", { children: param.label || param.name }),
      /* @__PURE__ */ jsx("span", { className: "ds-value", children: String(current ?? "") })
    ] }),
    param.type === "bool" ? /* @__PURE__ */ jsx("input", { type: "checkbox", checked: Boolean(current), onChange: (e) => change(e.target.checked) }) : param.type === "enum" ? /* @__PURE__ */ jsx(NativeSelect, { label: param.label || param.name, value: current, onChange: change, children: (param.options || param.values || []).map((v) => /* @__PURE__ */ jsx("option", { value: v, children: v }, v)) }) : param.type === "color" ? /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
      /* @__PURE__ */ jsx("input", { type: "color", "aria-label": param.label || param.name, value: current || "#ffffff", onChange: (e) => change(e.target.value) }),
      /* @__PURE__ */ jsx("span", { className: "ds-mono", children: current })
    ] }) : /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
      /* @__PURE__ */ jsx("input", { style: { flex: 1, minWidth: 60 }, "aria-label": param.label || param.name, type: "range", min: param.min ?? 0, max: param.max ?? 1, step: param.type === "int" ? 1 : param.step ?? 0.01, value: current ?? 0, onPointerDown: begin, onPointerUp: end, onPointerCancel: end, onKeyDown: (e) => {
        if (!e.repeat) begin();
      }, onKeyUp: end, onBlur: end, onChange: (e) => change(e.target.value) }),
      /* @__PURE__ */ jsx(Input, { "aria-label": `${param.label || param.name} exact value`, type: "number", style: { width: 76 }, min: param.min, max: param.max, step: param.type === "int" ? 1 : param.step ?? 0.01, value: current ?? 0, onChange: (e) => change(e.target.value) })
    ] })
  ] });
}
function Parameters({ params = [], values = {}, onChange }) {
  return /* @__PURE__ */ jsx("div", { className: "ds-fields", children: params.map((p) => /* @__PURE__ */ jsx(Parameter, { param: p, value: values[p.name], onChange: (value, gesture) => onChange(p.name, value, gesture) }, p.name)) });
}
function PreviewCanvas({ frame, zoom = "fit", label = "Project preview" }) {
  const container = useRef(null), canvas = useRef(null), bitmap = useRef(null), size = useRef({ width: 1, height: 1 });
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    function draw() {
      const node = canvas.current, image = bitmap.current;
      if (!node || !image) return;
      const { width, height } = size.current;
      const fit = zoom === "fit" ? Math.min(width / image.width, height / image.height, 1) : 1;
      const w = Math.max(1, Math.round(image.width * fit)), h = Math.max(1, Math.round(image.height * fit));
      const dpr = globalThis.devicePixelRatio || 1;
      node.width = Math.round(w * dpr);
      node.height = Math.round(h * dpr);
      node.style.width = `${w}px`;
      node.style.height = `${h}px`;
      const context = node.getContext("2d");
      if (!context) {
        setError("Canvas 2D is unavailable");
        return;
      }
      context.drawImage(image, 0, 0, node.width, node.height);
    }
    const observer = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) {
        size.current = { width: Math.max(1, r.width), height: Math.max(1, r.height) };
        draw();
      }
    });
    observer.observe(container.current);
    if (frame?.blob) createImageBitmap(frame.blob).then((image) => {
      if (!live) {
        image.close();
        return;
      }
      bitmap.current = image;
      setError("");
      draw();
    }).catch((e) => live && setError(String(e)));
    return () => {
      live = false;
      observer.disconnect();
      bitmap.current?.close();
      bitmap.current = null;
    };
  }, [frame, zoom]);
  return /* @__PURE__ */ jsxs("div", { className: "ds-canvas-wrap", ref: container, children: [
    /* @__PURE__ */ jsx("canvas", { ref: canvas, "aria-label": label }),
    !frame && /* @__PURE__ */ jsxs("div", { className: "ds-canvas-empty", children: [
      /* @__PURE__ */ jsx("span", { children: label }),
      /* @__PURE__ */ jsx("small", { children: "Waiting for the renderer" })
    ] }),
    error && /* @__PURE__ */ jsx("div", { role: "alert", children: error })
  ] });
}
function RecipesPanel({ catalog, service, doc, onRefresh, onApply, onParam }) {
  const [name, setName] = useState("My recipe"), [excluded, setExcluded] = useState([]), [exposed, setExposed] = useState([]), [error, setError] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [active, setActive] = useState(null);
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const stack = (doc?.stack || []).filter((n) => !excluded.includes(n.uid));
  async function save() {
    setBusy(true);
    setError("");
    try {
      const body = { name, stack, exposed: exposed.filter((e) => stack.some((n) => n.uid === e.node_uid)) };
      const recipe = await service.rest("/recipes", { method: "POST", body });
      if (!live.current) return;
      const state = await onRefresh();
      if (!live.current) return;
      if (!state.catalog?.recipes.some((r) => r.id === recipe.id)) throw new Error("Saved recipe not found in the refreshed catalog. Refresh and review.");
      setNotice(`Saved ${recipe.name} on the gateway.`);
    } catch (e) {
      if (live.current) setError(String(e.message || e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function apply(recipe) {
    setBusy(true);
    setError("");
    try {
      const result = await onApply(recipe.id);
      if (!live.current || !result) return;
      const appended = result.document.stack.slice(-recipe.stack.length);
      setActive({ recipe, project: result.document.id, bindings: Object.fromEntries(recipe.stack.map((n, i) => [n.uid, appended[i]?.uid])) });
      setNotice(`Applied ${recipe.name}. Exposed controls edit its newly added operations.`);
    } catch (e) {
      if (live.current) setError(String(e.message || e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return /* @__PURE__ */ jsxs("section", { className: "ds-fields", children: [
    /* @__PURE__ */ jsx("h3", { children: "Reusable stacks" }),
    /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Save an ordered subchain with frozen tool versions. Applying appends its operations; it never replaces the source image." }),
    /* @__PURE__ */ jsxs("details", { open: !catalog.recipes.length, children: [
      /* @__PURE__ */ jsx("summary", { children: "Save current stack" }),
      /* @__PURE__ */ jsxs("div", { className: "ds-fields", style: { paddingTop: 12 }, children: [
        /* @__PURE__ */ jsxs("label", { className: "ds-field", children: [
          "Recipe name",
          /* @__PURE__ */ jsx(Input, { "aria-label": "Recipe name", value: name, onChange: (e) => setName(e.target.value) })
        ] }),
        doc?.stack.length ? doc.stack.map((n, i) => {
          const tool = catalog.tools.find((t) => t.ref === n.tool);
          return /* @__PURE__ */ jsxs("div", { className: "ds-card", children: [
            /* @__PURE__ */ jsxs("label", { className: "ds-row", children: [
              /* @__PURE__ */ jsx("input", { type: "checkbox", "aria-label": `Include operation ${i + 1} in recipe`, checked: !excluded.includes(n.uid), onChange: (e) => setExcluded((prev) => e.target.checked ? prev.filter((uid) => uid !== n.uid) : [...prev, n.uid]) }),
              i + 1,
              ". ",
              tool?.manifest.name || n.tool
            ] }),
            !excluded.includes(n.uid) && (tool?.manifest.params || []).map((p) => {
              const descriptor = exposed.find((e) => e.node_uid === n.uid && e.param === p.name);
              return /* @__PURE__ */ jsxs("div", { className: "ds-field", children: [
                /* @__PURE__ */ jsxs("label", { className: "ds-row", children: [
                  /* @__PURE__ */ jsx("input", { "aria-label": `Expose ${p.name} from operation ${i + 1}`, type: "checkbox", checked: Boolean(descriptor), onChange: (e) => setExposed((prev) => e.target.checked ? [...prev, { name: `control${prev.length + 1}`, node_uid: n.uid, param: p.name }] : prev.filter((d) => d !== descriptor)) }),
                  p.label || p.name
                ] }),
                descriptor && /* @__PURE__ */ jsx(Input, { "aria-label": `Exposed name for ${p.name} from operation ${i + 1}`, value: descriptor.name, onChange: (e) => setExposed((prev) => prev.map((d) => d === descriptor ? { ...d, name: e.target.value } : d)) })
              ] }, p.name);
            })
          ] }, n.uid);
        }) : /* @__PURE__ */ jsx(Message, { children: "Add operations before saving a recipe." }),
        /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Check the parameters you want to expose. Exposed names must be unique identifiers (letters, digits, underscore)." }),
        /* @__PURE__ */ jsx(Button, { disabled: !stack.length || !name.trim() || busy, onClick: save, children: "Save recipe" })
      ] })
    ] }),
    error && /* @__PURE__ */ jsx("div", { role: "alert", className: "ds-mono", children: error }),
    notice && /* @__PURE__ */ jsx("p", { role: "status", className: "ds-muted", children: notice }),
    catalog.recipes.length ? catalog.recipes.map((recipe) => /* @__PURE__ */ jsxs("div", { className: "ds-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
        /* @__PURE__ */ jsx("h3", { children: recipe.name }),
        /* @__PURE__ */ jsx(Action, { "aria-label": `Apply ${recipe.name}`, disabled: !doc || busy, onClick: () => apply(recipe), children: "Apply" })
      ] }),
      /* @__PURE__ */ jsxs("p", { className: "ds-muted", children: [
        recipe.stack.length,
        " operations \xB7 ",
        (recipe.exposed || []).length,
        " exposed controls"
      ] }),
      /* @__PURE__ */ jsx("span", { className: "ds-number", children: recipe.id })
    ] }, recipe.id)) : /* @__PURE__ */ jsx(Message, { children: "No saved recipes yet. Save your first stack above." }),
    active && active.project === doc?.id && (active.recipe.exposed || []).length > 0 && /* @__PURE__ */ jsxs("section", { className: "ds-fields", children: [
      /* @__PURE__ */ jsxs("h3", { children: [
        active.recipe.name,
        " \xB7 exposed controls"
      ] }),
      active.recipe.exposed.map((descriptor) => {
        const uid = active.bindings[descriptor.node_uid], node = doc.stack.find((n) => n.uid === uid), tool = catalog.tools.find((t) => t.ref === node?.tool), param = tool?.manifest.params.find((p) => p.name === descriptor.param);
        return node && param ? /* @__PURE__ */ jsx(Parameter, { param: { ...param, label: descriptor.name }, value: node.params[descriptor.param], onChange: (value, gesture) => onParam(uid, descriptor.param, value, gesture) }, descriptor.name) : /* @__PURE__ */ jsxs("p", { className: "ds-muted", children: [
          descriptor.name,
          ": operation was removed."
        ] }, descriptor.name);
      })
    ] })
  ] });
}
function ParameterTable({ params, onChange }) {
  function update(index, patch) {
    onChange(params.map((p, i) => i === index ? { ...p, ...patch } : p));
  }
  function changeType(index, type) {
    const defaults = { float: { default: 0, min: 0, max: 1 }, int: { default: 0, min: 0, max: 10 }, bool: { default: false }, color: { default: "#ffffff" }, enum: { default: "soft", options: ["soft", "hard"] } };
    const old = params[index];
    onChange(params.map((p, i) => i === index ? { name: old.name, label: old.label || old.name, type, ...defaults[type] } : p));
  }
  return /* @__PURE__ */ jsxs("section", { className: "ds-fields", children: [
    /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
      /* @__PURE__ */ jsx("h3", { children: "Parameter manifest" }),
      /* @__PURE__ */ jsx(Action, { onClick: () => onChange([...params, { name: `amount${params.length + 1}`, type: "float", min: 0, max: 1, default: 0.5 }]), children: "Add parameter" })
    ] }),
    /* @__PURE__ */ jsx("div", { className: "ds-table-wrap", children: /* @__PURE__ */ jsxs("table", { children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("th", { children: "Name / label" }),
        /* @__PURE__ */ jsx("th", { children: "Type" }),
        /* @__PURE__ */ jsx("th", { children: "Range / options" }),
        /* @__PURE__ */ jsx("th", { children: "Default" }),
        /* @__PURE__ */ jsx("th", {})
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: params.map((p, i) => /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsxs("td", { children: [
          /* @__PURE__ */ jsx(Input, { "aria-label": `Parameter ${i + 1} name`, value: p.name, onChange: (e) => update(i, { name: e.target.value }) }),
          /* @__PURE__ */ jsx(Input, { "aria-label": `Parameter ${i + 1} label`, placeholder: "Display label", value: p.label || "", onChange: (e) => update(i, { label: e.target.value }) })
        ] }),
        /* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx(NativeSelect, { label: `Parameter ${i + 1} type`, value: p.type, onChange: (type) => changeType(i, type), children: TYPES.map((t) => /* @__PURE__ */ jsx("option", { children: t }, t)) }) }),
        /* @__PURE__ */ jsx("td", { children: p.type === "float" || p.type === "int" ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx(Input, { "aria-label": `Parameter ${i + 1} minimum`, type: "number", value: p.min, step: p.type === "int" ? 1 : "any", onChange: (e) => update(i, { min: e.target.value === "" ? "" : Number(e.target.value) }) }),
          /* @__PURE__ */ jsx(Input, { "aria-label": `Parameter ${i + 1} maximum`, type: "number", value: p.max, step: p.type === "int" ? 1 : "any", onChange: (e) => update(i, { max: e.target.value === "" ? "" : Number(e.target.value) }) })
        ] }) : p.type === "enum" ? /* @__PURE__ */ jsx(Input, { "aria-label": `Parameter ${i + 1} options`, placeholder: "soft, hard", value: (p.options || []).join(", "), onChange: (e) => update(i, { options: e.target.value.split(",").map((v) => v.trim()) }) }) : /* @__PURE__ */ jsx("span", { className: "ds-muted", children: "\u2014" }) }),
        /* @__PURE__ */ jsx("td", { children: p.type === "bool" ? /* @__PURE__ */ jsx("input", { "aria-label": `Parameter ${i + 1} default`, type: "checkbox", checked: p.default === true, onChange: (e) => update(i, { default: e.target.checked }) }) : p.type === "enum" ? /* @__PURE__ */ jsx(NativeSelect, { label: `Parameter ${i + 1} default`, value: p.default, onChange: (value) => update(i, { default: value }), children: (p.options || []).map((o, index) => /* @__PURE__ */ jsx("option", { children: o }, index)) }) : /* @__PURE__ */ jsx(Input, { "aria-label": `Parameter ${i + 1} default`, type: p.type === "color" ? "color" : "number", value: p.default, step: p.type === "int" ? 1 : "any", onChange: (e) => update(i, { default: p.type === "color" ? e.target.value : e.target.value === "" ? "" : Number(e.target.value) }) }) }),
        /* @__PURE__ */ jsx("td", { children: /* @__PURE__ */ jsx(Action, { "aria-label": `Remove parameter ${i + 1}`, onClick: () => onChange(params.filter((_, index) => i !== index)), children: "\xD7" }) })
      ] }, i)) })
    ] }) }),
    !params.length && /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "No custom uniforms yet. Add float, int, bool, color or enum controls." })
  ] });
}
function DraftEditor({ entry, service, doc, onRefresh, onClose }) {
  const [model, setModel] = useState(() => entry ? { name: entry.manifest.name, description: entry.manifest.description || "", params: entry.manifest.params, shader: entry.shader } : { ...initialDraft, params: [] });
  const [saved, setSaved] = useState(entry || null), [values, setValues] = useState(() => paramDefaults(entry?.manifest.params)), [status, setStatus] = useState("Waiting for edits"), [error, setError] = useState(""), [check2, setCheck] = useState(null), [frames, setFrames] = useState(null), [confirmDelete, setConfirmDelete] = useState(false), [action, setAction] = useState("");
  const live = useRef(true), generation = useRef(0);
  const modelKey = JSON.stringify(model), valuesKey = JSON.stringify(values);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      generation.current++;
    };
  }, []);
  function edit(patch) {
    generation.current++;
    setCheck(null);
    setFrames(null);
    setModel((previous) => ({ ...previous, ...patch }));
    setStatus("Edits pending \u2014 compile in 600 ms");
  }
  useEffect(() => {
    const token = ++generation.current;
    let cancelled = false;
    setCheck(null);
    setStatus("Compile scheduled\u2026");
    const active = () => !cancelled && live.current && token === generation.current && !service.signal.aborted;
    const timer = setTimeout(async () => {
      if (!active()) return;
      setStatus("Saving and compiling\u2026");
      setError("");
      try {
        const draft = await service.rest("/drafts", { method: "POST", body: JSON.parse(modelKey) });
        if (!active()) return;
        setSaved(draft);
        const params = { ...paramDefaults(model.params), ...JSON.parse(valuesKey) };
        const currentResult = await service.checkDraft(draft, { fixture: false, params });
        if (!active()) return;
        const testResult = await service.checkDraft(draft, { fixture: true, params });
        if (!active()) return;
        for (const result of [currentResult, testResult]) {
          if (result?.ok === false || result?.error || result?.check?.error) throw new Error(result.error || result.check?.error || "Shader check failed");
          const validated = result?.request?.entry;
          if (!validated || !draft.expected_shader_sha || !draft.expected_manifest_sha || validated.manifest.id !== draft.manifest.id || validated.expected_shader_sha !== draft.expected_shader_sha || validated.expected_manifest_sha !== draft.expected_manifest_sha || result.entry?.expected_shader_sha !== validated.expected_shader_sha || result.entry?.expected_manifest_sha !== validated.expected_manifest_sha || result.request.shader_sha !== validated.expected_shader_sha || result.check?.shader_sha !== validated.expected_shader_sha || !result.request.request_id || result.check?.request_id !== result.request.request_id)
            throw new Error("Draft snapshot/check identity changed. Refresh and compile again.");
        }
        const current = currentResult.frame || currentResult, test = testResult.frame || testResult;
        if (!current?.blob || !test?.blob) throw new Error("Renderer returned no preview. Approval is unavailable until both checks complete.");
        setFrames({ current, test });
        setCheck({ id: testResult.entry.manifest.id, expected_shader_sha: testResult.entry.expected_shader_sha, expected_manifest_sha: testResult.entry.expected_manifest_sha, request_ids: [currentResult.request.request_id, testResult.request.request_id], token });
        setStatus("Compiled \xB7 current image + studio test image");
        await onRefresh();
      } catch (e) {
        if (active()) {
          setError(String(e.message || e));
          setStatus("Check failed \xB7 edit the source and retry");
          setCheck(null);
        }
      }
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [modelKey, valuesKey, doc?.id, doc?.revision, service]);
  async function approve() {
    if (!saved || !check2 || check2.token !== generation.current) return;
    setAction("approve");
    try {
      await service.rest("/drafts/approve", { method: "POST", body: { id: check2.id, expected_shader_sha: check2.expected_shader_sha, expected_manifest_sha: check2.expected_manifest_sha } });
      if (!live.current) return;
      const state = await onRefresh();
      if (!live.current) return;
      if (!state.catalog?.tools.some((t) => t.manifest.id === saved.manifest.id)) throw new Error("Approval response received, but tool is not in the refreshed catalog. Refresh and review.");
      onClose();
    } catch (e) {
      if (live.current) {
        setError(String(e.message || e));
        setCheck(null);
        setStatus("Approval failed \xB7 refresh and compile again");
      }
    } finally {
      if (live.current) setAction("");
    }
  }
  async function remove() {
    if (!saved) return;
    setAction("delete");
    try {
      await service.rest(`/drafts?id=${encodeURIComponent(saved.manifest.id)}`, { method: "DELETE" });
      if (!live.current) return;
      const state = await onRefresh();
      if (!live.current) return;
      if (state.catalog?.drafts.some((t) => t.manifest.id === saved.manifest.id)) throw new Error("Draft still exists after deletion. Refresh and try again.");
      onClose();
    } catch (e) {
      if (live.current) setError(String(e.message || e));
    } finally {
      if (live.current) setAction("");
    }
  }
  return /* @__PURE__ */ jsxs("section", { className: "ds-fields", "aria-label": "Manual shader editor", children: [
    /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
      /* @__PURE__ */ jsx("h2", { children: "Shader workshop" }),
      /* @__PURE__ */ jsx(Action, { onClick: onClose, children: "\u2190 Drafts" })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Write a GLSL ES 3.00 fragment tool. No agent is required. Changes save and compile after a short pause." }),
    /* @__PURE__ */ jsxs("label", { className: "ds-field", children: [
      "Tool name",
      /* @__PURE__ */ jsx(Input, { "aria-label": "Tool name", value: model.name, onChange: (e) => edit({ name: e.target.value }) })
    ] }),
    /* @__PURE__ */ jsxs("label", { className: "ds-field", children: [
      "Description",
      /* @__PURE__ */ jsx(Input, { "aria-label": "Tool description", value: model.description, onChange: (e) => edit({ description: e.target.value }) })
    ] }),
    /* @__PURE__ */ jsxs("details", { children: [
      /* @__PURE__ */ jsx("summary", { children: "Shader contract & safety" }),
      /* @__PURE__ */ jsxs("p", { className: "ds-muted ds-mono", children: [
        "u_input \xB7 u_resolution \xB7 u_time (0) \xB7 u_seed \xB7 v_uv \xB7 outColor",
        /* @__PURE__ */ jsx("br", {}),
        "Parameters: p_name; float / int / bool; color \u2192 linear vec3; enum \u2192 int index.",
        /* @__PURE__ */ jsx("br", {}),
        "Write functions and main() only. The renderer supplies uniforms and precision. Maximum 32 KiB; no while / do; literal for bounds \u2264 256. These checks are not a GPU sandbox."
      ] })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "ds-field", children: [
      /* @__PURE__ */ jsx("span", { children: "Fragment shader" }),
      /* @__PURE__ */ jsxs("div", { className: "ds-code", children: [
        /* @__PURE__ */ jsx("div", { className: "ds-lines", "aria-hidden": "true", children: model.shader.split("\n").map((_, i) => i + 1).join("\n") }),
        /* @__PURE__ */ jsx(Textarea, { "aria-label": "GLSL fragment shader", spellCheck: false, value: model.shader, onChange: (e) => edit({ shader: e.target.value }) })
      ] })
    ] }),
    /* @__PURE__ */ jsx(ParameterTable, { params: model.params, onChange: (params) => {
      setValues(paramDefaults(params));
      edit({ params });
    } }),
    /* @__PURE__ */ jsx("div", { role: "status", className: "ds-muted", children: status }),
    error && /* @__PURE__ */ jsx("pre", { role: "alert", className: "ds-mono", style: { whiteSpace: "pre-wrap" }, children: error }),
    model.params.length > 0 && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx("h3", { children: "Preview controls" }),
      /* @__PURE__ */ jsx(Parameters, { params: model.params, values, onChange: (name, value) => {
        generation.current++;
        setCheck(null);
        setValues((previous) => ({ ...previous, [name]: value }));
      } })
    ] }),
    /* @__PURE__ */ jsxs("div", { className: "ds-fields", children: [
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h3", { children: "Current image" }),
        /* @__PURE__ */ jsx("div", { className: "ds-mini-preview", children: /* @__PURE__ */ jsx(PreviewCanvas, { frame: frames?.current, label: "Draft on current image" }) })
      ] }),
      /* @__PURE__ */ jsxs("div", { children: [
        /* @__PURE__ */ jsx("h3", { children: "Studio test image" }),
        /* @__PURE__ */ jsx("div", { className: "ds-mini-preview", children: /* @__PURE__ */ jsx(PreviewCanvas, { frame: frames?.test, label: "Draft on studio test image" }) })
      ] })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Only a human can approve a checked draft. Edits invalidate approval readiness; the backend verifies the exact source hash." }),
    /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
      /* @__PURE__ */ jsx(Button, { disabled: !check2 || check2.token !== generation.current || Boolean(action), onClick: approve, children: action === "approve" ? "Approving\u2026" : "Approve tool" }),
      /* @__PURE__ */ jsx(Action, { disabled: !saved || Boolean(action), onClick: () => setConfirmDelete(true), children: "Delete draft" })
    ] }),
    confirmDelete && /* @__PURE__ */ jsxs("div", { className: "ds-card", children: [
      /* @__PURE__ */ jsx("p", { children: "Delete this saved draft? Approved tools are not affected." }),
      /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
        /* @__PURE__ */ jsx(Action, { disabled: Boolean(action), onClick: remove, children: "Confirm delete" }),
        /* @__PURE__ */ jsx(Action, { onClick: () => setConfirmDelete(false), children: "Cancel" })
      ] })
    ] })
  ] });
}
function DraftsPanel({ catalog, service, doc, onRefresh }) {
  const [editing, setEditing] = useState(null);
  return editing ? /* @__PURE__ */ jsx(DraftEditor, { entry: editing === "new" ? null : editing, service, doc, onRefresh, onClose: () => setEditing(null) }, editing === "new" ? "new" : editing.manifest.id) : /* @__PURE__ */ jsxs("section", { className: "ds-fields", children: [
    /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
      /* @__PURE__ */ jsx("h3", { children: "Your shader tools" }),
      /* @__PURE__ */ jsx(Action, { onClick: () => setEditing("new"), children: "New tool" })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Create manually, or edit an agent-created draft. Drafts never enter the operation stack until you approve them." }),
    catalog.drafts.length ? catalog.drafts.map((entry) => /* @__PURE__ */ jsxs("div", { className: "ds-card", children: [
      /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
        /* @__PURE__ */ jsx("h3", { children: entry.manifest.name }),
        /* @__PURE__ */ jsx(Action, { onClick: () => setEditing(entry), children: "Edit" })
      ] }),
      /* @__PURE__ */ jsx("p", { className: "ds-muted", children: entry.manifest.description || "Draft shader tool" }),
      /* @__PURE__ */ jsx("span", { className: "ds-number", children: entry.check?.ok ? "Checked \xB7 awaiting human approval" : "Needs compile check" })
    ] }, entry.manifest.id)) : /* @__PURE__ */ jsx(Message, { children: "No drafts yet. Make your first tool with New tool." })
  ] });
}
function ExportActions({ service, ctx, doc, onError }) {
  const [download, setDownload] = useState(null), [busy, setBusy] = useState(""), [library, setLibrary] = useState(null), [hint, setHint] = useState("");
  const current = useRef(null), url = useRef(null);
  current.current = doc;
  useEffect(() => {
    setDownload(null);
    setLibrary(null);
    setBusy("");
    setHint("");
    if (url.current) {
      URL.revokeObjectURL(url.current);
      url.current = null;
    }
    return () => {
      if (url.current) {
        URL.revokeObjectURL(url.current);
        url.current = null;
      }
    };
  }, [doc?.id, doc?.revision]);
  async function prepare() {
    const target = doc;
    setBusy("client");
    setHint("Rendering full-resolution PNG on this computer\u2026");
    try {
      const result = await service.renderProject(target, { kind: "export" });
      if (current.current !== target) return;
      const href = URL.createObjectURL(result.blob);
      if (url.current) URL.revokeObjectURL(url.current);
      url.current = href;
      setDownload({ href, width: result.width, height: result.height });
      setHint("Ready. Click Save as\u2026 to open the native save dialog on this computer.");
    } catch (e) {
      if (current.current === target) {
        onError(e);
        setHint("Client export failed. You can try Save to library as a separate gateway export.");
      }
    } finally {
      if (current.current === target) setBusy("");
    }
  }
  async function saveLibrary() {
    const target = doc;
    setBusy("gateway");
    try {
      const result = await service.saveLibrary(target);
      if (current.current === target) {
        setLibrary(result);
        setHint("PNG saved in the library on the gateway, not necessarily this computer.");
      }
    } catch (e) {
      if (current.current === target) onError(e);
    } finally {
      if (current.current === target) setBusy("");
    }
  }
  useEffect(() => () => {
    current.current = null;
  }, []);
  const path = library?.path || library?.stored_path || library?.receipt?.path;
  return /* @__PURE__ */ jsxs("section", { className: "ds-upload", children: [
    /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
      /* @__PURE__ */ jsx(Action, { disabled: !doc || Boolean(busy), onClick: prepare, children: busy === "client" ? "Preparing PNG\u2026" : "Prepare PNG" }),
      download && /* @__PURE__ */ jsx("a", { href: download.href, download: `design-studio-r${doc.revision}.png`, children: "Save as\u2026" }),
      /* @__PURE__ */ jsx(Action, { disabled: !doc || Boolean(busy), onClick: saveLibrary, children: busy === "gateway" ? "Saving\u2026" : "Save to library" })
    ] }),
    (hint || download) && /* @__PURE__ */ jsxs("p", { className: "ds-muted", role: "status", children: [
      hint,
      download && ` ${download.width} \xD7 ${download.height} pixels.`
    ] }),
    path && /* @__PURE__ */ jsxs("div", { className: "ds-muted", children: [
      /* @__PURE__ */ jsxs("span", { className: "ds-mono", children: [
        "Gateway: ",
        path
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
        /* @__PURE__ */ jsx(Action, { onClick: () => ctx.os.writeClipboard(path), children: "Copy path" }),
        /* @__PURE__ */ jsx(Action, { onClick: async () => {
          const revealed = await ctx.os.revealPath(path);
          if (!revealed) setHint("This gateway path is not accessible on this computer. Use client Save as for a local file.");
        }, children: "Reveal (local gateway only)" })
      ] })
    ] })
  ] });
}
function StudioPage({ service, ctx }) {
  const [doc, setDoc] = useState(null), [catalog, setCatalog] = useState({ tools: [], recipes: [], drafts: [] });
  const docRef = useRef(null), channel = useRef(null), life = useRef(null), uploadInput = useRef(null), importing = useRef(false), uploadTask = useRef(null);
  const [theme, setTheme] = useState(() => ctx.storage.get("theme", "native"));
  const [selected, setSelected] = useState(null), [tab, setTab] = useState("tools"), [frame, setFrame] = useState(null), [before, setBefore] = useState(null), [comparing, setComparing] = useState(false), [zoom, setZoom] = useState("fit");
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [rendering, setRendering] = useState(false), [busy, setBusy] = useState(""), [progress, setProgress] = useState(null), [drag, setDrag] = useState(false);
  const stateQuery = useQuery({ queryKey: [ctx.source || "hermes-design-studio", service.metadata().run_id, "manual-state"], queryFn: () => service.getState(), refetchInterval: 2500, retry: 1 });
  function publish(document2) {
    if (!document2) return;
    const current = docRef.current;
    if (current?.id === document2.id && current.revision >= document2.revision) return;
    docRef.current = document2;
    setDoc(document2);
  }
  function accept(state) {
    if (!state) return;
    publish(state.document);
    if (state.catalog) setCatalog(state.catalog);
  }
  async function refresh() {
    const state = await service.getState();
    if (!life.current?.signal.aborted) accept(state);
    return state;
  }
  function fail(e) {
    if (!life.current?.signal.aborted) setError(String(e.message || e));
  }
  function send(commands, gesture) {
    return channel.current?.send(commands, gesture).catch(fail);
  }
  function history(kind) {
    return channel.current?.action(`/history/${kind}`).catch(fail);
  }
  async function importFile(file) {
    if (!file || importing.current || !docRef.current) return;
    const controller = new AbortController();
    uploadTask.current = controller;
    const abort = () => controller.abort();
    life.current.signal.addEventListener("abort", abort, { once: true });
    importing.current = true;
    setBusy("Decoding image\u2026");
    setError("");
    setProgress(null);
    setComparing(false);
    try {
      await importImage(file, {
        signal: controller.signal,
        maxTextureSize: service.renderer.maxTextureSize,
        decode: (f) => createImageBitmap(f),
        show: (local) => {
          setFrame(local);
          setZoom("fit");
          setNotice("Local preview \u2014 uploading PNG to the gateway before applying it to the project.");
        },
        encode: async (bitmap) => {
          setBusy("Encoding PNG\u2026");
          const canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const c = canvas.getContext("2d");
          if (!c) throw new Error("Canvas 2D is unavailable");
          c.drawImage(bitmap, 0, 0);
          return new Promise((resolve, reject) => canvas.toBlob((b) => b ? resolve(b) : reject(new Error("PNG encoding failed")), "image/png"));
        },
        upload: (png) => {
          setBusy("Uploading image\u2026");
          return uploadChunks(png, { rest: service.rest, signal: controller.signal, onProgress: (p) => {
            if (!controller.signal.aborted) setProgress(p);
          } });
        },
        send: (commands) => channel.current.send(commands)
      });
      if (!controller.signal.aborted) setNotice("Image imported and saved on the gateway.");
    } catch (e) {
      if (!controller.signal.aborted) fail(new Error(`${e.message || e}
The local preview is not an applied project source if import failed. OAuth connections do not support uploads; connect using a token and retry. Gateway-path imports refer to the server, not this computer.`));
    } finally {
      life.current?.signal.removeEventListener("abort", abort);
      importing.current = false;
      if (!life.current?.signal.aborted) {
        setBusy("");
        setProgress(null);
      }
      uploadTask.current = null;
    }
  }
  useEffect(() => {
    accept(stateQuery.data);
  }, [stateQuery.data]);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    service.page(true);
    const stop = () => controller.abort();
    service.signal.addEventListener("abort", stop, { once: true });
    const transport = createCommandChannel({ rest: service.rest, getDocument: () => docRef.current, onDocument: publish, refresh: () => service.getState(), onConflict: () => {
      setError("The project changed elsewhere. Loaded the current revision; your edit was not replayed. Review and try again.");
      void stateQuery.refetch();
    } });
    channel.current = transport;
    const keys = [["undo", "mod+z"], ["redo", "mod+shift+z"]].map(([kind, key]) => ctx.register({ id: `studio-${kind}`, area: KEYBINDS_AREA, data: { id: `design-studio.${kind}`, label: `Design Studio: ${kind}`, category: "view", defaults: [key], run: () => {
      if (!controller.signal.aborted && docRef.current) void history(kind);
    } } }));
    return () => {
      controller.abort();
      transport.dispose();
      keys.forEach((dispose) => dispose());
      service.signal.removeEventListener("abort", stop);
      service.page(false);
    };
  }, [service, ctx]);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    setRendering(true);
    const timer = setTimeout(() => {
      service.renderProject(doc, { kind: "preview" }).then((result) => {
        if (live) {
          setFrame(result);
          setNotice("");
        }
      }).catch((e) => live && fail(e)).finally(() => live && setRendering(false));
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [doc, service]);
  useEffect(() => {
    if (!doc) return;
    let live = true;
    service.renderProject({ ...doc, stack: [] }, { kind: "preview", comparison: true }).then((result) => live && setBefore(result)).catch((e) => live && fail(e));
    return () => {
      live = false;
    };
  }, [doc?.id, doc?.source?.asset, service]);
  const node = doc?.stack.find((n) => n.uid === selected), tool = catalog.tools.find((t) => t.ref === node?.tool);
  const shownFrame = comparing ? before : frame;
  return /* @__PURE__ */ jsxs("main", { className: "hds", "data-theme": theme === "minimal" ? "minimal" : "native", children: [
    /* @__PURE__ */ jsx("style", { children: CSS }),
    /* @__PURE__ */ jsxs("header", { className: "ds-top", children: [
      /* @__PURE__ */ jsxs("div", { className: "ds-brand", children: [
        /* @__PURE__ */ jsx("span", { className: "ds-eyebrow", children: "Hermes \xB7 creative workspace" }),
        /* @__PURE__ */ jsx("h1", { children: "Design Studio" })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
        /* @__PURE__ */ jsx(Action, { disabled: !doc || Boolean(busy), onClick: () => channel.current?.action("/project/new").catch(fail), children: "New project" }),
        /* @__PURE__ */ jsx(Action, { disabled: !doc, onClick: () => history("undo"), children: "Undo" }),
        /* @__PURE__ */ jsx(Action, { disabled: !doc, onClick: () => history("redo"), children: "Redo" })
      ] }),
      /* @__PURE__ */ jsxs(NativeSelect, { label: "Interface theme", value: theme, onChange: (value) => {
        setTheme(value);
        ctx.storage.set("theme", value);
      }, children: [
        /* @__PURE__ */ jsx("option", { value: "native", children: "Hermes Native" }),
        /* @__PURE__ */ jsx("option", { value: "minimal", children: "Minimal" })
      ] }),
      /* @__PURE__ */ jsx(Action, { onClick: () => host.navigate("/design-studio/diagnostics"), children: "Diagnostics \u2197" })
    ] }),
    (error || stateQuery.error) && /* @__PURE__ */ jsxs("div", { className: "ds-alert", role: "alert", children: [
      /* @__PURE__ */ jsx(Action, { "aria-label": "Dismiss error", onClick: () => setError(""), children: "Dismiss" }),
      error || String(stateQuery.error)
    ] }),
    notice && /* @__PURE__ */ jsx("div", { className: "ds-alert", role: "status", children: notice }),
    /* @__PURE__ */ jsxs("div", { className: "ds-columns", children: [
      /* @__PURE__ */ jsxs("aside", { className: "ds-panel ds-left", "aria-label": "Operation stack", children: [
        /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
          /* @__PURE__ */ jsx("h2", { children: "Operations" }),
          /* @__PURE__ */ jsx("span", { className: "ds-count", children: String(doc?.stack.length || 0).padStart(2, "0") })
        ] }),
        /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Applied in order, top to bottom." }),
        !doc ? /* @__PURE__ */ jsxs(Message, { children: [
          stateQuery.isLoading ? "Loading project\u2026" : "Project unavailable. Check the gateway connection.",
          /* @__PURE__ */ jsx(Action, { onClick: () => stateQuery.refetch(), children: "Retry" })
        ] }) : !doc.stack.length ? /* @__PURE__ */ jsxs(Message, { children: [
          /* @__PURE__ */ jsx("strong", { children: "A clean starting point" }),
          /* @__PURE__ */ jsx("span", { children: "Add a tool from the right to begin. Every operation stays editable." })
        ] }) : /* @__PURE__ */ jsx("div", { className: "ds-stack", children: doc.stack.map((n, index) => {
          const t = catalog.tools.find((t2) => t2.ref === n.tool);
          return /* @__PURE__ */ jsxs("div", { className: "ds-node", "data-selected": selected === n.uid, children: [
            /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
              /* @__PURE__ */ jsx("span", { className: "ds-number", children: String(index + 1).padStart(2, "0") }),
              /* @__PURE__ */ jsx("button", { className: "ds-node-title", onClick: () => setSelected(n.uid), children: /* @__PURE__ */ jsx("span", { children: t?.manifest.name || n.tool }) }),
              /* @__PURE__ */ jsx("input", { type: "checkbox", "aria-label": `Enable ${t?.manifest.name || n.tool}`, checked: n.enabled, onChange: (e) => send([{ type: "set_node", uid: n.uid, enabled: e.target.checked }]) })
            ] }),
            /* @__PURE__ */ jsxs("div", { className: "ds-row ds-space", children: [
              /* @__PURE__ */ jsxs("span", { className: "ds-muted", children: [
                Math.round(n.opacity * 100),
                "% \xB7 ",
                n.blend
              ] }),
              /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
                /* @__PURE__ */ jsx(Action, { "aria-label": "Move operation up", disabled: index === 0, onClick: () => send([{ type: "move_node", uid: n.uid, index: index - 1 }]), children: "\u2191" }),
                /* @__PURE__ */ jsx(Action, { "aria-label": "Move operation down", disabled: index === doc.stack.length - 1, onClick: () => send([{ type: "move_node", uid: n.uid, index: index + 1 }]), children: "\u2193" }),
                /* @__PURE__ */ jsx(Action, { "aria-label": "Remove operation", onClick: () => send([{ type: "remove_node", uid: n.uid }]), children: "\xD7" })
              ] })
            ] })
          ] }, n.uid);
        }) }),
        /* @__PURE__ */ jsxs("div", { className: "ds-bottom", children: [
          doc && /* @__PURE__ */ jsxs("section", { className: "ds-fields", children: [
            /* @__PURE__ */ jsx(Parameter, { param: { name: "seed", label: "Seed", type: "int", min: 0, max: 16777215, default: 0 }, value: doc.seed, onChange: (value, gesture) => send([{ type: "set_seed", seed: value }], gesture) }),
            /* @__PURE__ */ jsx(Action, { onClick: () => send([{ type: "set_seed", seed: (doc.seed + 1) % 16777216 }]), children: "Next seed" })
          ] }),
          /* @__PURE__ */ jsx("p", { className: "ds-muted", children: doc ? `Revision ${doc.revision}` : "No project loaded" }),
          /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Edits are saved on the gateway. New project retains earlier project files." })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("section", { className: "ds-canvas-column", "aria-label": "Image workspace", children: [
        /* @__PURE__ */ jsxs("div", { className: "ds-canvas-toolbar", children: [
          /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
            /* @__PURE__ */ jsx(Action, { onClick: () => uploadInput.current?.click(), disabled: Boolean(busy), children: "Upload image" }),
            /* @__PURE__ */ jsx("input", { ref: uploadInput, hidden: true, type: "file", accept: "image/*", disabled: Boolean(busy) || !doc, onChange: (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              void importFile(file);
            } })
          ] }),
          /* @__PURE__ */ jsxs("div", { className: "ds-row", children: [
            /* @__PURE__ */ jsx(Action, { "aria-pressed": zoom === "fit", onClick: () => setZoom("fit"), children: "Fit" }),
            /* @__PURE__ */ jsx(Action, { "aria-pressed": zoom === "100", onClick: () => setZoom("100"), children: "100%" }),
            /* @__PURE__ */ jsx(Action, { disabled: !before, onPointerDown: (e) => {
              e.currentTarget.setPointerCapture?.(e.pointerId);
              setComparing(true);
            }, onPointerUp: () => setComparing(false), onPointerCancel: () => setComparing(false), onLostPointerCapture: () => setComparing(false), onKeyDown: (e) => {
              if (e.key === " ") {
                e.preventDefault();
                setComparing(true);
              }
            }, onKeyUp: () => setComparing(false), onBlur: () => setComparing(false), children: "Hold before / after" })
          ] })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "ds-viewport", tabIndex: 0, "aria-label": "Canvas. Hold backslash to compare", "data-drag": drag, onDragOver: (e) => {
          e.preventDefault();
          if (!busy) setDrag(true);
        }, onDragLeave: (e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setDrag(false);
        }, onDrop: (e) => {
          e.preventDefault();
          setDrag(false);
          void importFile(e.dataTransfer.files?.[0]);
        }, onKeyDown: (e) => {
          if (e.key === "\\" && !e.repeat) {
            e.preventDefault();
            setComparing(true);
          }
        }, onKeyUp: (e) => {
          if (e.key === "\\") setComparing(false);
        }, onBlur: () => setComparing(false), children: /* @__PURE__ */ jsx(PreviewCanvas, { frame: shownFrame, zoom, label: comparing ? "Original image" : "Project preview" }) }),
        busy && /* @__PURE__ */ jsxs("div", { className: "ds-alert", role: "status", children: [
          busy,
          progress && /* @__PURE__ */ jsxs(Fragment, { children: [
            /* @__PURE__ */ jsx("progress", { value: progress.bytes_received, max: progress.bytes_total }),
            /* @__PURE__ */ jsxs("small", { children: [
              progress.index + 1,
              " / ",
              progress.total,
              " chunks \xB7 ",
              progress.bytes_received.toLocaleString(),
              " / ",
              progress.bytes_total.toLocaleString(),
              " bytes"
            ] })
          ] }),
          /* @__PURE__ */ jsx(Action, { onClick: () => {
            uploadTask.current?.abort();
            setNotice("Import cancelled. Any local preview has not replaced the project source.");
          }, children: "Cancel import" })
        ] }),
        /* @__PURE__ */ jsxs("div", { style: { padding: "10px 14px", borderTop: "1px solid var(--ui-stroke-secondary)" }, children: [
          /* @__PURE__ */ jsx(ExportActions, { service, ctx, doc, onError: fail }),
          /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Upload / Save as: this computer. Library and agent file paths: gateway." })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "ds-canvas-foot", children: [
          /* @__PURE__ */ jsx("span", { children: doc?.source ? `${doc.source.w} \xD7 ${doc.source.h} \xB7 source image` : "Studio test image \xB7 upload to use your own" }),
          /* @__PURE__ */ jsx("span", { children: rendering ? "Rendering\u2026" : frame ? `${frame.width} \xD7 ${frame.height} preview` : "Renderer waiting" })
        ] })
      ] }),
      /* @__PURE__ */ jsxs("aside", { className: "ds-panel ds-right", "aria-label": "Tool controls and library", children: [
        /* @__PURE__ */ jsxs("section", { className: "ds-fields", children: [
          /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
            /* @__PURE__ */ jsx("h2", { children: tool?.manifest.name || "Parameters" }),
            node && /* @__PURE__ */ jsx("span", { className: "ds-count", children: "Selected operation" })
          ] }),
          node ? /* @__PURE__ */ jsxs(Fragment, { children: [
            /* @__PURE__ */ jsx(Parameters, { params: tool?.manifest.params, values: node.params, onChange: (name, value, gesture) => send([{ type: "set_params", uid: node.uid, params: { [name]: value } }], gesture) }),
            /* @__PURE__ */ jsx(Parameter, { param: { name: "opacity", label: "Opacity", type: "float", min: 0, max: 1, default: 1 }, value: node.opacity, onChange: (value, gesture) => send([{ type: "set_node", uid: node.uid, opacity: value }], gesture) }),
            /* @__PURE__ */ jsxs("label", { className: "ds-field", children: [
              /* @__PURE__ */ jsx("span", { children: "Blend mode" }),
              /* @__PURE__ */ jsx(NativeSelect, { label: "Blend mode", value: node.blend, onChange: (blend) => send([{ type: "set_node", uid: node.uid, blend }]), children: ["normal", "multiply", "screen", "overlay"].map((b) => /* @__PURE__ */ jsx("option", { children: b }, b)) })
            ] })
          ] }) : /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Select an operation in the stack to adjust its controls." })
        ] }),
        /* @__PURE__ */ jsx("div", { className: "ds-divider" }),
        /* @__PURE__ */ jsx("nav", { className: "ds-tabs", role: "tablist", "aria-label": "Studio library", children: ["tools", "recipes", "drafts"].map((t) => /* @__PURE__ */ jsx(Action, { role: "tab", "aria-selected": tab === t, onClick: () => setTab(t), children: t[0].toUpperCase() + t.slice(1) }, t)) }),
        /* @__PURE__ */ jsx("div", { role: "tabpanel", children: tab === "tools" ? /* @__PURE__ */ jsx("div", { className: "ds-fields", children: catalog.tools.length ? catalog.tools.map((t) => /* @__PURE__ */ jsxs("div", { className: "ds-card", children: [
          /* @__PURE__ */ jsxs("div", { className: "ds-heading", children: [
            /* @__PURE__ */ jsx("h3", { children: t.manifest.name }),
            /* @__PURE__ */ jsx(Action, { "aria-label": `Add ${t.manifest.name}`, disabled: !doc, onClick: () => send([{ type: "add_node", tool: t.ref }]), children: "+ Add" })
          ] }),
          /* @__PURE__ */ jsx("p", { className: "ds-muted", children: t.manifest.description || "Add this non-destructive operation to your stack." }),
          /* @__PURE__ */ jsxs("span", { className: "ds-number", children: [
            t.status === "builtin" ? "Built-in" : "Your tool",
            " \xB7 v",
            t.manifest.version || 1,
            " \xB7 ",
            (t.manifest.params || []).length,
            " controls"
          ] })
        ] }, t.ref)) : /* @__PURE__ */ jsxs(Message, { children: [
          "No tools loaded. Retry when the gateway is connected.",
          /* @__PURE__ */ jsx(Action, { onClick: () => refresh().catch(fail), children: "Refresh catalog" })
        ] }) }) : tab === "drafts" ? /* @__PURE__ */ jsx(DraftsPanel, { catalog, service, doc, onRefresh: refresh }) : /* @__PURE__ */ jsx(RecipesPanel, { catalog, service, doc, onRefresh: refresh, onApply: (id) => channel.current.action("/recipes/apply", { id }), onParam: (uid, name, value, gesture) => send([{ type: "set_params", uid, params: { [name]: value } }], gesture) }) })
      ] })
    ] })
  ] });
}
function DiagnosticsPage({ service, ctx }) {
  const [report, setReport] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const live = useRef(false);
  useEffect(() => {
    live.current = true;
    service.page(true);
    return () => {
      live.current = false;
      service.page(false);
    };
  }, [service]);
  async function run() {
    setBusy(true);
    setError("");
    try {
      const result = await service.diagnostics();
      if (live.current) setReport(result);
    } catch (e) {
      if (live.current) setError(String(e));
    } finally {
      if (live.current) setBusy(false);
    }
  }
  return /* @__PURE__ */ jsxs("main", { className: "hds", "data-theme": ctx.storage.get("theme", "native"), children: [
    /* @__PURE__ */ jsx("style", { children: CSS }),
    /* @__PURE__ */ jsxs("header", { className: "ds-top", children: [
      /* @__PURE__ */ jsxs("div", { className: "ds-brand", children: [
        /* @__PURE__ */ jsx("span", { className: "ds-eyebrow", children: "Hermes Design Studio" }),
        /* @__PURE__ */ jsx("h1", { children: "Renderer diagnostics" })
      ] }),
      /* @__PURE__ */ jsx(Action, { onClick: () => host.navigate("/design-studio"), children: "\u2190 Back to Studio" }),
      /* @__PURE__ */ jsx(Button, { disabled: busy, onClick: run, children: busy ? "Checking pixels\u2026" : "Run diagnostics" })
    ] }),
    /* @__PURE__ */ jsxs("section", { className: "ds-panel", children: [
      /* @__PURE__ */ jsx("p", { className: "ds-muted", children: "Runs the actual built-in shaders on fixed fixtures and compares rendered pixels with independent expectations. Results are saved to diagnostics.json on the gateway." }),
      error && /* @__PURE__ */ jsx("div", { role: "alert", className: "ds-alert", children: error }),
      !report ? /* @__PURE__ */ jsx(Message, { children: "No checks run yet. Start diagnostics to test this Desktop GPU." }) : /* @__PURE__ */ jsxs(Fragment, { children: [
        /* @__PURE__ */ jsx("h2", { children: report.pass ? "All checks passed" : "One or more checks failed" }),
        /* @__PURE__ */ jsxs("table", { children: [
          /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
            /* @__PURE__ */ jsx("th", { children: "Tool" }),
            /* @__PURE__ */ jsx("th", { children: "Result" }),
            /* @__PURE__ */ jsx("th", { children: "Details" })
          ] }) }),
          /* @__PURE__ */ jsx("tbody", { children: (report.checks || []).map((c, i) => /* @__PURE__ */ jsxs("tr", { children: [
            /* @__PURE__ */ jsx("td", { children: c.tool || c.name }),
            /* @__PURE__ */ jsx("td", { children: c.pass ? "PASS" : "FAIL" }),
            /* @__PURE__ */ jsx("td", { className: "ds-mono", children: c.error || JSON.stringify(c) })
          ] }, i)) })
        ] })
      ] })
    ] })
  ] });
}

// core/diagnostics.mjs
var W = 8;
var H = 8;
function fixture() {
  const rgba = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) rgba.set([(x * 31 + y * 17) % 256, (x * 13 + y * 37) % 256, (x * 47 + y * 7) % 256, 64 + (x + y) * 19 % 192], (y * W + x) * 4);
  return { width: W, height: H, rgba };
}
var clamp = (v) => Math.min(1, Math.max(0, v));
var byte = (v) => Math.round(clamp(v) * 255);
var luma = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
function sample(src, x, y) {
  x = Math.max(0, Math.min(W - 1, Math.floor(x)));
  y = Math.max(0, Math.min(H - 1, Math.floor(y)));
  return [...src.rgba.slice((y * W + x) * 4, (y * W + x + 1) * 4)];
}
function expectedPixels(src, fn) {
  const out = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out.push(...fn(sample(src, x, y), x, y));
  return out;
}
function colorLinear(hex) {
  return [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
}
function colorBytes(c) {
  return c.map((v) => byte(v <= 31308e-7 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
}
function palette(a, b, t) {
  a = colorLinear(a);
  b = colorLinear(b);
  return colorBytes(a.map((v, i) => v * (1 - t) + b[i] * t));
}
function bayer(n) {
  let m = [[0]];
  for (let s = 1; s < n; s *= 2) {
    const next = Array.from({ length: s * 2 }, () => []);
    for (let y = 0; y < s * 2; y++) for (let x = 0; x < s * 2; x++) next[y][x] = 4 * m[y % s][x % s] + [[0, 2], [3, 1]][Math.floor(y / s)][Math.floor(x / s)];
    m = next;
  }
  return m;
}
function ditherReference(src, p) {
  const n = Number(p.matrix), matrix = bayer(n);
  return expectedPixels(src, (c, x, y) => {
    const levels = p.use_palette ? 2 : p.levels;
    const q = clamp(Math.floor(luma(c) / 255 * (levels - 1) + (matrix[y % n][x % n] + 0.5) / (n * n)) / (levels - 1));
    return [...p.use_palette ? palette(p.dark, p.light, q) : [byte(q), byte(q), byte(q)], c[3]];
  });
}
function grainNoise(x, y, seed) {
  const mask = 0xffffffffn;
  let n = BigInt(x) * 1973n + BigInt(y) * 9277n + BigInt(seed) * 26699n & mask;
  n = (n ^ n >> 13n) * 1274126177n & mask;
  n = (n ^ n >> 16n) & mask;
  return Number(n & 65535n) / 65535 - 0.5;
}
function levelsReference(src, p) {
  return expectedPixels(src, (c) => {
    const adjusted = c.slice(0, 3).map((v) => clamp((v / 255 + p.brightness - 0.5) * p.contrast + 0.5) ** (1 / p.gamma));
    const gray = luma(adjusted);
    return [...adjusted.map((v) => byte(gray + (v - gray) * p.saturation)), c[3]];
  });
}
var suites = {
  levels: [{}, { brightness: 0.2 }, { contrast: 1.5 }, { gamma: 1.8 }, { saturation: 0 }, { brightness: -0.1, contrast: 0.8, gamma: 1.4, saturation: 1.6 }].map((p) => ({ params: { brightness: 0, contrast: 1, gamma: 1, saturation: 1, ...p }, reference: levelsReference })),
  chromatic_aberration: [{ offset: 1, angle: 0 }, { offset: 2, angle: 90 }].map((params) => ({ params, reference: (src, p) => expectedPixels(src, (c, x, y) => {
    const dx = p.offset * Math.cos(p.angle * Math.PI / 180), dy = p.offset * Math.sin(p.angle * Math.PI / 180);
    return [sample(src, x + 0.5 + dx, y + 0.5 + dy)[0], c[1], sample(src, x + 0.5 - dx, y + 0.5 - dy)[2], c[3]];
  }) })),
  grain: [0, 0.4].map((amount) => ({ params: { amount }, reference: (src, p) => expectedPixels(src, (c, x, y) => [...c.slice(0, 3).map((v) => byte(v / 255 + p.amount * grainNoise(x, y, 17))), c[3]]) })),
  gradient_map: [false, true].map((three_colors) => ({ params: { three_colors, dark: "#204060", middle: "#d09030", light: "#f0e0a0" }, reference: (src, p) => expectedPixels(src, (c) => {
    const t = luma(c) / 255;
    return [...!p.three_colors ? palette(p.dark, p.light, t) : t < 0.5 ? palette(p.dark, p.middle, t * 2) : palette(p.middle, p.light, t * 2 - 1), c[3]];
  }) })),
  halftone: [{ size: 3, angle: 0 }, { size: 4, angle: 37 }].map((params) => ({ params, reference: (src, p) => expectedPixels(src, (c, x, y) => {
    const a = p.angle * Math.PI / 180, xx = (x + 0.5) * Math.cos(a) - (y + 0.5) * Math.sin(a), yy = (x + 0.5) * Math.sin(a) + (y + 0.5) * Math.cos(a);
    const dx = (xx / p.size % 1 + 1) % 1 - 0.5, dy = (yy / p.size % 1 + 1) % 1 - 0.5;
    const value = dx * dx + dy * dy <= (1 - luma(c) / 255) * 0.25 ? 0 : 255;
    return [value, value, value, c[3]];
  }) })),
  dither: [2, 4, 8].flatMap((n) => [2, 5, 8].map((levels) => ({ params: { matrix: String(n), levels, use_palette: false }, reference: ditherReference }))).concat([{ params: { matrix: "4", levels: 3, use_palette: true, dark: "#204060", light: "#e0c080" }, reference: ditherReference }]),
  pixelate: [{ params: { size: 2 }, reference: (src, p) => expectedPixels(src, (_, x, y) => sample(src, Math.floor(x / p.size) * p.size + p.size / 2, Math.floor(y / p.size) * p.size + p.size / 2)) }]
};
async function runDiagnostics(renderer, tools) {
  const source = fixture(), checks = [];
  const names = ["pixelate", "dither", "halftone", "gradient_map", "grain", "chromatic_aberration", "levels"];
  for (const name of names) {
    const ref = `builtin/${name}@1`, entry = tools.find((e) => (e.ref || `${e.manifest.id}@${e.manifest.version}`) === ref), cases = [];
    if (!entry || !suites[name]) {
      checks.push({ tool: ref, pass: false, error: !entry ? "Builtin missing" : "Independent reference missing" });
      continue;
    }
    for (const spec of suites[name]) {
      try {
        const expected = spec.reference(source, spec.params);
        const frame = await renderer.render({ format: 1, source: { w: W, h: H }, stack: [{ tool: ref, params: spec.params }], seed: 17, timeline: null }, 0, { tools: [entry], source });
        let max_error = 0, mismatched = 0;
        for (let i = 0; i < expected.length; i++) {
          const error = Math.abs(frame.rgba[i] - expected[i]);
          max_error = Math.max(max_error, error);
          if (error > (spec.tolerance ?? 1)) mismatched++;
        }
        cases.push({ params: spec.params, pass: mismatched === 0, max_error, mismatched_channels: mismatched, compared_channels: expected.length, expected_first_pixels: expected.slice(0, 16), actual_first_pixels: [...frame.rgba.slice(0, 16)], metrics: frame.metrics });
      } catch (e) {
        cases.push({ params: spec.params, pass: false, error: String(e) });
      }
    }
    checks.push({ tool: ref, pass: cases.length > 0 && cases.every((c) => c.pass), cases });
  }
  return { format: 1, pass: checks.length === 7 && checks.every((c) => c.pass), checks, fixture: { width: W, height: H, description: "deterministic asymmetric RGBA8 pattern; top-down straight alpha" }, comparison: "all channels against independent CPU references; RGBA8 tolerance 1 byte unless stated", renderer: renderer.info };
}

// hermes/plugin.jsx
import { jsx as jsx2, jsxs as jsxs2 } from "react/jsx-runtime";
var BUILD = "design-studio-p1-20261111-studio-1";
var fixture2 = { format: 1, id: "p0", revision: 0, source: null, stack: [], seed: 1234, timeline: null };
var layout = { padding: 24, display: "grid", gap: 16, color: "var(--ui-text-primary)", overflow: "auto", height: "100%", boxSizing: "border-box" };
var box = { padding: 16, border: "1px solid var(--ui-stroke-secondary)", borderRadius: 8 };
function ServiceMount({ service }) {
  useQuery2({
    queryKey: ["hermes-design-studio", service.metadata().run_id, "service-poll"],
    queryFn: async () => {
      const state = await service.rest("/state");
      await service.accept(state, "poll");
      await service.cache(state.document);
      return { revision: state.document.revision, at: Date.now() };
    },
    refetchInterval: 2500,
    refetchIntervalInBackground: true,
    retry: 1
  });
  return null;
}
function RiskPage({ service, diagnostics = false }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot);
  const [image, setImage] = useState2(null), [error, setError] = useState2(""), [busy, setBusy] = useState2(false);
  const [progress, setProgress] = useState2(null), [result, setResult] = useState2(null), [save, setSave] = useState2("not tested");
  const task = useRef2(null), urls = useRef2(/* @__PURE__ */ new Set());
  function ownURL(blob) {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  }
  useEffect2(() => {
    const controller = new AbortController();
    task.current = controller;
    service.page(true);
    const abort = () => controller.abort();
    service.signal.addEventListener("abort", abort, { once: true });
    service.report({ page: { active: true, route: diagnostics ? "/design-studio/diagnostics" : "/design-studio" } }).catch(() => {
    });
    service.render(fixture2, 0).then((frame) => {
      if (!controller.signal.aborted) setImage(ownURL(frame.blob));
    }).catch((e) => {
      if (!controller.signal.aborted) setError(String(e));
    });
    return () => {
      controller.abort();
      service.signal.removeEventListener("abort", abort);
      service.page(false);
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
      if (!service.signal.aborted) service.report({ page: { active: false } }).catch(() => {
      });
    };
  }, [service, diagnostics]);
  async function upload(blob, label) {
    const signal = task.current.signal;
    const uploaded = await uploadChunks(blob, { rest: service.rest, signal, onProgress: async (p) => {
      if (signal.aborted) return;
      setProgress(p);
      await service.report({ upload_probe: { label, status: "uploading", ...p } });
    } });
    if (signal.aborted) return;
    const observation = { ...uploaded, label, status: "complete", actual_png_bytes: blob.size, at_least_20MiB: blob.size >= 20 * 1024 * 1024 };
    await service.report({ upload_probe: observation });
    if (!signal.aborted) setResult(observation);
  }
  async function probe() {
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const blob = await makeUploadProbe(document.createElement("canvas"), task.current.signal);
      await upload(blob, "generated-high-entropy-PNG");
    } catch (e) {
      if (!task.current.signal.aborted) {
        setError(String(e));
        await service.report({ upload_probe: { status: "error", error: String(e), hint: "OAuth remote uploads are unsupported; use token connection." } }).catch(() => {
        });
      }
    } finally {
      if (!task.current.signal.aborted) setBusy(false);
    }
  }
  async function importFile(file) {
    if (!file) return;
    setBusy(true);
    setError("");
    let bitmap;
    const signal = task.current.signal;
    try {
      bitmap = await createImageBitmap(file);
      if (signal.aborted) return;
      if (Math.max(bitmap.width, bitmap.height) > service.renderer.maxTextureSize) throw new Error(`Image exceeds GPU texture limit ${service.renderer.maxTextureSize}px`);
      const localCanvas = document.createElement("canvas");
      localCanvas.width = bitmap.width;
      localCanvas.height = bitmap.height;
      localCanvas.getContext("2d").drawImage(bitmap, 0, 0);
      const localPng = await new Promise((resolve, reject) => localCanvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Imported PNG encoding failed")), "image/png"));
      if (signal.aborted) return;
      setImage(ownURL(localPng));
      await upload(file, "user-file-on-this-computer");
      if (!signal.aborted) await service.report({ import: { name: file.name, width: bitmap.width, height: bitmap.height, bytes: file.size, stored: true, applied_to_project: false } });
    } catch (e) {
      if (!signal.aborted) setError(String(e) + " Upload uses this computer; server-path import is a separate agent action. OAuth remote upload requires token connection.");
    } finally {
      bitmap?.close();
      if (!signal.aborted) setBusy(false);
    }
  }
  function saveClicked() {
    setSave("clicked \u2014 native dialog awaiting your confirmation");
    service.report({ save_as: { clicked: true, dialog_verified: false, method: "plugin-owned-anchor-download" } }).catch(() => {
    });
  }
  async function verifyDialog() {
    setSave("dialog confirmed by user");
    await service.report({ save_as: { clicked: true, dialog_verified: true, evidence: "explicit-user-confirmation" } });
  }
  return /* @__PURE__ */ jsxs2("main", { style: layout, children: [
    /* @__PURE__ */ jsxs2("header", { children: [
      /* @__PURE__ */ jsxs2("h1", { children: [
        "Hermes Design Studio \xB7 P0 ",
        diagnostics ? "diagnostics" : "risk probe"
      ] }),
      /* @__PURE__ */ jsx2("p", { children: "Detached WebGL2 service, chunk upload and client-side Save as. P0 renders a fixed gradient, not a shader stack." }),
      /* @__PURE__ */ jsxs2("small", { children: [
        "Build ",
        BUILD,
        " \xB7 run ",
        snapshot.run_id
      ] })
    ] }),
    /* @__PURE__ */ jsxs2("section", { style: box, children: [
      /* @__PURE__ */ jsx2("h2", { children: "Service proof" }),
      /* @__PURE__ */ jsx2("p", { children: "Navigate to chat, then request preview/export in a fresh agent session. This page is not the renderer lifetime." }),
      /* @__PURE__ */ jsx2("pre", { style: { whiteSpace: "pre-wrap" }, children: JSON.stringify(snapshot, null, 2) }),
      /* @__PURE__ */ jsx2("p", { children: "page_active must be false in the resulting service report. A ready label is not a pass." }),
      /* @__PURE__ */ jsx2(Button2, { onClick: () => host2.navigate("/design-studio/diagnostics"), children: "Diagnostics" }),
      " ",
      /* @__PURE__ */ jsx2(Button2, { onClick: () => host2.navigate("/"), children: "Leave page for chat" })
    ] }),
    /* @__PURE__ */ jsxs2("section", { style: box, onDragOver: (e) => e.preventDefault(), onDrop: (e) => {
      e.preventDefault();
      if (!busy) importFile(e.dataTransfer.files[0]);
    }, children: [
      /* @__PURE__ */ jsx2("h2", { children: "Image on this computer" }),
      /* @__PURE__ */ jsxs2("label", { children: [
        "Upload image ",
        /* @__PURE__ */ jsx2("input", { type: "file", accept: "image/*", disabled: busy, onChange: (e) => importFile(e.target.files[0]) })
      ] }),
      /* @__PURE__ */ jsx2("p", { children: "Drop an image here. P0 decodes and stores chunks; importing does not yet change the project." }),
      image && /* @__PURE__ */ jsx2("img", { src: image, alt: "P0 fixture or local imported image", style: { maxWidth: "100%", maxHeight: 280, objectFit: "contain" } }),
      /* @__PURE__ */ jsx2("p", { children: image && /* @__PURE__ */ jsx2("a", { href: image, download: "design-studio-p0.png", onClick: saveClicked, children: "Save as\u2026 (on this computer)" }) }),
      /* @__PURE__ */ jsx2("p", { children: save }),
      /* @__PURE__ */ jsx2(Button2, { onClick: verifyDialog, disabled: !save.startsWith("clicked"), children: "I saw the native Save dialog" }),
      /* @__PURE__ */ jsx2("p", { children: "No automatic download clicks. Backend export paths are on the gateway, not necessarily this computer." })
    ] }),
    /* @__PURE__ */ jsxs2("section", { style: box, children: [
      /* @__PURE__ */ jsx2("h2", { children: "\u226520 MiB actual PNG upload probe" }),
      /* @__PURE__ */ jsx2(Button2, { disabled: busy, onClick: probe, children: busy ? "Working\u2026" : "Generate PNG and upload 4 MiB chunks" }),
      progress && /* @__PURE__ */ jsxs2("p", { children: [
        progress.index + 1,
        "/",
        progress.total,
        " receipts \xB7 ",
        progress.bytes_received,
        "/",
        progress.bytes_total,
        " bytes"
      ] }),
      result && /* @__PURE__ */ jsx2("pre", { style: { whiteSpace: "pre-wrap" }, children: JSON.stringify(result, null, 2) }),
      /* @__PURE__ */ jsx2("p", { children: "Success requires the assembled backend SHA-256 to equal the browser digest. No generated pass before receipts." })
    ] }),
    error && /* @__PURE__ */ jsxs2("section", { role: "alert", style: box, children: [
      /* @__PURE__ */ jsx2("h2", { children: "Observed error" }),
      /* @__PURE__ */ jsx2("pre", { style: { whiteSpace: "pre-wrap" }, children: error })
    ] })
  ] });
}
var plugin_default = { id: "hermes-design-studio", name: "Hermes Design Studio", register(ctx) {
  const canvas = document.createElement("canvas");
  const renderer = createRenderer(canvas);
  const service = createService(ctx, renderer, { runId: crypto.randomUUID(), build: BUILD, diagnosticsRunner: runDiagnostics });
  ctx.register({ id: "service", area: TITLEBAR_AREAS.right, render: () => /* @__PURE__ */ jsx2(ServiceMount, { service }) });
  ctx.register({ id: "page", area: ROUTES_AREA, data: { path: "/design-studio" }, render: () => /* @__PURE__ */ jsx2(StudioPage, { service, ctx }) });
  ctx.register({ id: "diagnostics", area: ROUTES_AREA, data: { path: "/design-studio/diagnostics" }, render: () => /* @__PURE__ */ jsx2(DiagnosticsPage, { service, ctx }) });
  ctx.register({ id: "p0-risks", area: ROUTES_AREA, data: { path: "/design-studio/p0" }, render: () => /* @__PURE__ */ jsx2(RiskPage, { service }) });
  ctx.register({ id: "nav", area: SIDEBAR_NAV_AREA, data: { path: "/design-studio", label: "Design Studio", codicon: "paintcan" } });
  ctx.register({ id: "command", area: PALETTE_AREA, data: { id: "design-studio.open", label: "Design Studio: open workspace", keywords: ["design", "studio"], run: () => host2.navigate("/design-studio") } });
  ctx.onEvent("*", (event) => {
    if (!event.type?.startsWith("plugin.hermes-design-studio.")) return;
    service.rest("/state").then(async (state) => {
      await service.accept(state, "event");
      await service.cache(state.document);
    }).catch(() => {
    });
  });
  service.report({ runtime: { user_agent: navigator.userAgent, renderer: renderer.info, max_texture_size: renderer.maxTextureSize }, service: { status: "registered", page_active: false, detached_canvas: !canvas.isConnected } }).catch(() => {
  });
} };
export {
  BUILD,
  plugin_default as default
};
