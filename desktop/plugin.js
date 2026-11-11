// hermes/plugin.jsx
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { host, useQuery, Button, ROUTES_AREA, SIDEBAR_NAV_AREA, PALETTE_AREA, TITLEBAR_AREAS } from "@hermes/plugin-sdk";

// core/metrics.mjs
function frameMetrics(rgba, width, height) {
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
    difference_source: null,
    difference_previous: null,
    metrics_scope: "P0 fixture; differences not measured"
  };
}

// core/renderer.mjs
var vertex = `#version 300 es
out vec2 v_uv;
void main() { vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2); v_uv=p; gl_Position=vec4(p*2.0-1.0,0,1); }`;
var fragment = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform float u_time;
uniform float u_seed;
out vec4 outColor;
void main() { outColor=vec4(v_uv.x,v_uv.y,0.25+0.0*u_time+0.0*u_seed,1.0); }`;
function createRenderer(canvas) {
  const gl = canvas.getContext("webgl2", { preserveDrawingBuffer: true, alpha: false, antialias: false });
  if (!gl) throw new Error("WebGL2 unavailable; no renderer fallback enabled");
  let disposed = false;
  const shaders = [], programs = [];
  function compile(type, source) {
    const shader = gl.createShader(type);
    shaders.push(shader);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) || "Shader compile failed");
    return shader;
  }
  let program;
  try {
    program = gl.createProgram();
    programs.push(program);
    gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) || "Shader link failed");
  } catch (error) {
    for (const p of programs) gl.deleteProgram(p);
    for (const s of shaders) gl.deleteShader(s);
    throw error;
  }
  const vao = gl.createVertexArray();
  const limit = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  function dispose() {
    if (disposed) return;
    disposed = true;
    gl.deleteVertexArray(vao);
    for (const p of programs) gl.deleteProgram(p);
    for (const s of shaders) gl.deleteShader(s);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    canvas.width = 1;
    canvas.height = 1;
  }
  function render(document2, time = 0, { kind = "preview" } = {}) {
    if (disposed) throw new Error("Renderer disposed");
    if (document2?.format !== 1) throw new Error("Unsupported project format");
    if (time !== 0) throw new Error("P0 reserves u_time=0");
    let width = document2.source?.w || 640, height = document2.source?.h || 400;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error("Invalid dimensions");
    const cap = Math.min(limit, kind === "export" ? 4096 : 1600);
    if (kind === "export" && Math.max(width, height) > cap) throw new Error(`Export exceeds ${cap}px GPU/export limit`);
    const scale = Math.min(1, cap / Math.max(width, height));
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
    canvas.width = width;
    canvas.height = height;
    gl.viewport(0, 0, width, height);
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.uniform1f(gl.getUniformLocation(program, "u_time"), 0);
    gl.uniform1f(gl.getUniformLocation(program, "u_seed"), document2.seed || 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const rgba = new Uint8Array(width * height * 4);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`WebGL error ${error}`);
    const metrics = frameMetrics(rgba, width, height);
    return new Promise((resolve, reject) => canvas.toBlob((blob) => {
      if (disposed) return reject(new DOMException("Renderer disposed", "AbortError"));
      if (!blob) return reject(new Error("PNG encoding failed"));
      resolve({ blob, width, height, metrics, rgba, fixture: true });
    }, "image/png"));
  }
  return { render, dispose, canvas, maxTextureSize: limit, info: { version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(gl.RENDERER) } };
}

// hermes/service.mjs
function createService(ctx, renderer, { runId, build }) {
  const controller = new AbortController();
  const handled = /* @__PURE__ */ new Set(), inflight = /* @__PURE__ */ new Set();
  let pageCount = 0, cacheRevision = null;
  let tail = Promise.resolve();
  let snapshot = { run_id: runId, build, detached_canvas: true, page_active: false, status: "ready" };
  const listeners = /* @__PURE__ */ new Set();
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
    const frame = await renderer.render(doc, 0, { kind: request.kind || "preview" });
    alive();
    const bytes = await frame.blob.arrayBuffer();
    alive();
    const meta = metadata({
      request_id: request.request_id,
      kind: request.kind || "preview",
      revision: doc.revision,
      via,
      width: frame.width,
      height: frame.height,
      metrics: frame.metrics,
      fixture: true,
      u_time: 0
    });
    const path = cache2 ? `/preview/cache?revision=${doc.revision}&meta=${encodeURIComponent(JSON.stringify(meta))}` : `/render/response?id=${encodeURIComponent(request.request_id)}&meta=${encodeURIComponent(JSON.stringify(meta))}`;
    const receipt = await rest(path, { method: "POST", upload: { filename: "p0-preview.png", contentType: "image/png", bytes }, timeoutMs: 15e3 });
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
  async function accept(data, via = "poll") {
    if (controller.signal.aborted) return;
    const work = [];
    for (const request of data.requests || data.pending || []) {
      if (handled.has(request.request_id) || inflight.has(request.request_id)) continue;
      inflight.add(request.request_id);
      work.push(enqueue(() => renderOne(request, via)).then(() => handled.add(request.request_id)).catch((error) => {
        if (!controller.signal.aborted) {
          publish({ status: "error", error: String(error) });
          throw error;
        }
      }).finally(() => inflight.delete(request.request_id)));
    }
    await Promise.all(work);
  }
  function cache(document2) {
    if (controller.signal.aborted || cacheRevision === document2.revision) return Promise.resolve();
    cacheRevision = document2.revision;
    return enqueue(() => renderOne({ document: document2, kind: "preview" }, "poll", true)).catch((error) => {
      cacheRevision = null;
      if (!controller.signal.aborted) {
        publish({ status: "error", error: String(error) });
        throw error;
      }
    });
  }
  function dispose() {
    if (controller.signal.aborted) return;
    controller.abort();
    renderer.dispose();
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

// hermes/plugin.jsx
import { jsx, jsxs } from "react/jsx-runtime";
var BUILD = "design-studio-p0-20261111-detached-1";
var fixture = { format: 1, id: "p0", revision: 0, source: null, stack: [], seed: 1234, timeline: null };
var layout = { padding: 24, display: "grid", gap: 16, color: "var(--ui-text-primary)", overflow: "auto", height: "100%", boxSizing: "border-box" };
var box = { padding: 16, border: "1px solid var(--ui-stroke-secondary)", borderRadius: 8 };
function ServiceMount({ service }) {
  useQuery({
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
  const [image, setImage] = useState(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null), [result, setResult] = useState(null), [save, setSave] = useState("not tested");
  const task = useRef(null), urls = useRef(/* @__PURE__ */ new Set());
  function ownURL(blob) {
    const url = URL.createObjectURL(blob);
    urls.current.add(url);
    return url;
  }
  useEffect(() => {
    const controller = new AbortController();
    task.current = controller;
    service.page(true);
    const abort = () => controller.abort();
    service.signal.addEventListener("abort", abort, { once: true });
    service.report({ page: { active: true, route: diagnostics ? "/design-studio/diagnostics" : "/design-studio" } }).catch(() => {
    });
    service.render(fixture, 0).then((frame) => {
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
  return /* @__PURE__ */ jsxs("main", { style: layout, children: [
    /* @__PURE__ */ jsxs("header", { children: [
      /* @__PURE__ */ jsxs("h1", { children: [
        "Hermes Design Studio \xB7 P0 ",
        diagnostics ? "diagnostics" : "risk probe"
      ] }),
      /* @__PURE__ */ jsx("p", { children: "Detached WebGL2 service, chunk upload and client-side Save as. P0 renders a fixed gradient, not a shader stack." }),
      /* @__PURE__ */ jsxs("small", { children: [
        "Build ",
        BUILD,
        " \xB7 run ",
        snapshot.run_id
      ] })
    ] }),
    /* @__PURE__ */ jsxs("section", { style: box, children: [
      /* @__PURE__ */ jsx("h2", { children: "Service proof" }),
      /* @__PURE__ */ jsx("p", { children: "Navigate to chat, then request preview/export in a fresh agent session. This page is not the renderer lifetime." }),
      /* @__PURE__ */ jsx("pre", { style: { whiteSpace: "pre-wrap" }, children: JSON.stringify(snapshot, null, 2) }),
      /* @__PURE__ */ jsx("p", { children: "page_active must be false in the resulting service report. A ready label is not a pass." }),
      /* @__PURE__ */ jsx(Button, { onClick: () => host.navigate("/design-studio/diagnostics"), children: "Diagnostics" }),
      " ",
      /* @__PURE__ */ jsx(Button, { onClick: () => host.navigate("/"), children: "Leave page for chat" })
    ] }),
    /* @__PURE__ */ jsxs("section", { style: box, onDragOver: (e) => e.preventDefault(), onDrop: (e) => {
      e.preventDefault();
      if (!busy) importFile(e.dataTransfer.files[0]);
    }, children: [
      /* @__PURE__ */ jsx("h2", { children: "Image on this computer" }),
      /* @__PURE__ */ jsxs("label", { children: [
        "Upload image ",
        /* @__PURE__ */ jsx("input", { type: "file", accept: "image/*", disabled: busy, onChange: (e) => importFile(e.target.files[0]) })
      ] }),
      /* @__PURE__ */ jsx("p", { children: "Drop an image here. P0 decodes and stores chunks; importing does not yet change the project." }),
      image && /* @__PURE__ */ jsx("img", { src: image, alt: "P0 fixture or local imported image", style: { maxWidth: "100%", maxHeight: 280, objectFit: "contain" } }),
      /* @__PURE__ */ jsx("p", { children: image && /* @__PURE__ */ jsx("a", { href: image, download: "design-studio-p0.png", onClick: saveClicked, children: "Save as\u2026 (on this computer)" }) }),
      /* @__PURE__ */ jsx("p", { children: save }),
      /* @__PURE__ */ jsx(Button, { onClick: verifyDialog, disabled: !save.startsWith("clicked"), children: "I saw the native Save dialog" }),
      /* @__PURE__ */ jsx("p", { children: "No automatic download clicks. Backend export paths are on the gateway, not necessarily this computer." })
    ] }),
    /* @__PURE__ */ jsxs("section", { style: box, children: [
      /* @__PURE__ */ jsx("h2", { children: "\u226520 MiB actual PNG upload probe" }),
      /* @__PURE__ */ jsx(Button, { disabled: busy, onClick: probe, children: busy ? "Working\u2026" : "Generate PNG and upload 4 MiB chunks" }),
      progress && /* @__PURE__ */ jsxs("p", { children: [
        progress.index + 1,
        "/",
        progress.total,
        " receipts \xB7 ",
        progress.bytes_received,
        "/",
        progress.bytes_total,
        " bytes"
      ] }),
      result && /* @__PURE__ */ jsx("pre", { style: { whiteSpace: "pre-wrap" }, children: JSON.stringify(result, null, 2) }),
      /* @__PURE__ */ jsx("p", { children: "Success requires the assembled backend SHA-256 to equal the browser digest. No generated pass before receipts." })
    ] }),
    error && /* @__PURE__ */ jsxs("section", { role: "alert", style: box, children: [
      /* @__PURE__ */ jsx("h2", { children: "Observed error" }),
      /* @__PURE__ */ jsx("pre", { style: { whiteSpace: "pre-wrap" }, children: error })
    ] })
  ] });
}
var plugin_default = { id: "hermes-design-studio", name: "Hermes Design Studio", register(ctx) {
  const canvas = document.createElement("canvas");
  const renderer = createRenderer(canvas);
  const service = createService(ctx, renderer, { runId: crypto.randomUUID(), build: BUILD });
  ctx.register({ id: "service", area: TITLEBAR_AREAS.right, render: () => /* @__PURE__ */ jsx(ServiceMount, { service }) });
  ctx.register({ id: "page", area: ROUTES_AREA, data: { path: "/design-studio" }, render: () => /* @__PURE__ */ jsx(RiskPage, { service }) });
  ctx.register({ id: "diagnostics", area: ROUTES_AREA, data: { path: "/design-studio/diagnostics" }, render: () => /* @__PURE__ */ jsx(RiskPage, { service, diagnostics: true }) });
  ctx.register({ id: "nav", area: SIDEBAR_NAV_AREA, data: { path: "/design-studio", label: "Design Studio", codicon: "paintcan" } });
  ctx.register({ id: "command", area: PALETTE_AREA, data: { id: "design-studio.open", label: "Design Studio: open P0 risks", keywords: ["design", "studio"], run: () => host.navigate("/design-studio") } });
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
