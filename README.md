# Hermes Design Studio

A shader-based design workshop inside Hermes Desktop. Independent Python state and JavaScript rendering cores; one unified Hermes plugin. Hackathon build in progress.

## Build status

P0 risk gates are being implemented. **No runtime gate is considered passed until a report from the actual client Desktop has been read back.** Backend tests and separate Chromium tests are secondary evidence, not a substitute for that report.

Development source: `core/` (rendering), `studio_core/` (filesystem bridge/state), `hermes/` and `dashboard/` (adapters). Readable bundled `desktop/plugin.js` is committed. No WASM, native payload, HTML execution tools, or minification.

## Development installation

1. From the checkout, build with the pinned esbuild version and run `python scripts/install_dev.py`; it copies only this plugin into the default profile, without symlinks. Enable its backend with `hermes plugins enable hermes-design-studio`.
2. Restart the gateway/Desktop only at the agreed human handoff. Enable the Desktop half in Capabilities → Plugins, then open Design Studio. For a remote gateway, the client also needs `plugin.js` in its own `$HERMES_HOME/desktop-plugins/hermes-design-studio/` (the backend filesystem is not the client filesystem).

Do not restart the gateway from the agent's active session.

## Remote connections

Upload means **a file on this computer**, decoded/rendered on the Desktop client. Agent `import_image(path)` means **a path on the server**. Projects, upload assembly, cached previews and export history live in `<HERMES_HOME>/plugin-data/hermes-design-studio/` on the gateway. The Save as dialog belongs to the client. OAuth remote connections currently cannot use SDK multipart upload: connect using a gateway token instead; no authentication bypass is attempted.

## Safety and limits

GLSL is not a hardened sandbox. Planned backend checks (no while/do, bounded literal for loops, 32 KiB source limit) only reject obvious mistakes; they **do not guarantee protection against GPU hangs**. Do not run untrusted or deliberately heavy shaders. Shader compilation failures must be reported instead of silently applying a tool.

The first slice is static: project documents reserve `timeline: null`, rendering accepts `(document, time)`, and shader `u_time` remains zero. Agent actions will use revision-checked backend commands, exactly like manual UI actions. Agent-created tools require explicit human approval in the UI.

MIT. Detailed feature coverage, limitations, diagnostics and submission disclosure will be finalized in P3.
