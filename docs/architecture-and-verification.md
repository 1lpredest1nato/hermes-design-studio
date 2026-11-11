# Architecture, runtime and verification

## One package, independent cores

```text
Human → Desktop page ───────────┐
                              ↓
Agent → 7 tool adapters → studio_core (authoritative Python state)
                              ↓
                     plugin-data requests / responses
                              ↕ events + polling
                Desktop service → core WebGL2 renderer
                              ↓
                 PNG + metrics / compilation receipts
```

- `studio_core/`: projects, revision/identity checks, atomic command batches, journal, undo/redo, manifest validation, draft/versioned tool catalog, recipes, server-path image import and file-backed bridge. It does not import Hermes.
- `core/`: WebGL2 ping-pong rendering, shader-program cache, blend/compositing, frame metrics and independent fixture diagnostics. It does not depend on Hermes.
- `__init__.py`: tool/skill registration, plugin-data resolution and event broadcasting.
- `dashboard/plugin_api.py`: plugin-scoped backend HTTP API shared with the Desktop adapter; this is not a second image-processing implementation.
- `hermes/`: Desktop page, upload transport, SDK controls, persistent service and lifecycle handling.
- `desktop/plugin.js`: committed, readable ESM bundle. External imports are the Hermes SDK and React surfaces; no build tool is needed on the user's install path.

User-created content lives only in `<HERMES_HOME>/plugin-data/hermes-design-studio/`. POSIX `fcntl` locks coordinate filesystem state across processes, including isolated PluginHost tool calls and backend HTTP handlers. A Windows gateway is not supported. Runtime Python uses the standard library; Pillow is a verification tool, not a plugin runtime dependency.

## State and commands

Format-1 documents carry `id`, `revision`, source, linear `stack`, `seed` and `timeline: null`. Each operation has a UID, exact versioned tool reference, parameters, enabled flag, opacity and blend mode. A linear stack is not yet a branching graph editor.

The command set is `add_node`, `remove_node`, `move_node`, `set_params`, `set_node`, `set_source`, `apply_recipe`, `set_seed`. Both UI and agent use the Python implementation. A command batch is atomic; it requires **project_id + base_revision** and writes an identifiable journal entry with source `ui` or `agent`. Undo/redo is backend-owned, with gesture grouping for continuous UI edits.

Identity and revision are checked under the same lock. Two different projects can have the same revision. A mismatched project or revision produces 409 plus the current document without mutating it. Queued UI edits retain the project identity from submission; they must not be silently retargeted after switching projects. Agent callers must re-read and reconsider before retrying.

## Rendering service and evidence

The Desktop plugin creates a detached WebGL2 canvas during registration, independent of the page route. It processes durable render/check/export requests while that Desktop window remains open and connected. Events provide notification; polling is a fallback. Files rather than Python process memory carry requests/responses across the PluginHost boundary. Responses are matched by request id; the first accepted response wins if multiple Desktop windows answer.

Service requests do not depend on background `requestAnimationFrame`. Unload tears down resources/subscriptions and guards asynchronous continuations. An already-issued SDK IPC is not necessarily cancellable; the plugin must prevent later work after disposal instead of claiming that IPC was cancelled.

Preview waits are bounded at 10 seconds. The fallback may return a cached frame with explicit identity/revision and `stale` information. Export requires its actual PNG receipt; a cached preview does not count as an export. Without a connected renderer there is no GPU compilation or rendering on the gateway.

The renderer reports dimensions, mean/std luma, clipping, dominant colors, mean gradient, source/previous RGB differences and a nearly-uniform indicator. Comparisons that cannot be measured are null. Metrics support a model without vision but do not prove artistic quality, semantic content or an exact visual match to a request.

## Shader authoring contract

Write a **GLSL ES 3.00 fragment body**, with helper functions and `main()`. Do not duplicate the version/precision declarations or the renderer's supplied interface:

```glsl
uniform sampler2D u_input;
uniform vec2 u_resolution;
uniform float u_time; // reserved; always 0.0 in this build
uniform float u_seed;
in vec2 v_uv;
out vec4 outColor;
```

Manifest parameters generate `p_<name>` uniforms. `float`, `int` and `bool` map to corresponding GLSL types; a hex color becomes a linear RGB `vec3`; an enum becomes an integer option index. A minimal pass-through body is:

```glsl
void main() {
    outColor = texture(u_input, v_uv);
}
```

Adding a parameter declaration alone does not change pixels. The body must use its generated uniform. Preserve input alpha unless the intended effect changes it. Rendering uses sRGB 8-bit input and RGBA8 targets; it is not HDR or print color management.

Draft checking records the shader and canonical manifest fingerprints and checks an immutable snapshot. Manual approval is bound to the displayed successful check receipts and those same fingerprints. Replacing source/schema invalidates the approval readiness. The agent can create/check drafts but has no approval tool; generic HTTP/filesystem tools must not be used to bypass the human gate.

Static checks reject `while`/`do`, nonliteral or over-256 loop bounds and source over 32 KiB, along with invalid parameter declarations. **They are not a GPU sandbox, a cost proof or a guarantee against hangs.** Do not stress-test the GPU with deliberately hostile shaders. Animation is not implemented: `timeline` remains null and `u_time` is zero.

## Local versus remote files

- Upload and drag-and-drop read the client computer, decode in its browser, check its texture limit, normalize to PNG and send chunks of at most 4 MiB. A local displayed preview is not proof that the gateway has persisted it; wait for upload confirmation.
- Agent server-path import streams a gateway file into content-addressed assets, without a fixed file-size ceiling. PNG/JPEG/static WebP support is **header/metadata inspection only**, not full decoding. JPEG orientation is read. Browser decoding may reject damaged compressed content later. Animated WebP is rejected.
- Native **Prepare PNG → Save as…** belongs to the client. **Save to library** and `design_studio_export` belong to gateway plugin-data `exports/`. The latter returns path, dimensions and SHA-256.
- Preview longest side is at most 1600 px. Export preserves source resolution up to 4096 px per side and fails honestly above that cap; the client's GPU limit also applies. No hidden tiling or automatic full-resolution export downscale exists.
- Current SDK multipart Upload does not work over OAuth remote connections. Use a gateway-token connection; do not bypass the authentication layer.

## Verification record and boundaries

This is a documentation snapshot of checkpoint `f3aef873e24173a28677c8f28606175762e60b55`, not a new test execution.

| Gate | Recorded result | What it does not prove |
|---|---|---|
| Python and JavaScript suite | 355 Python + 55 JavaScript passed; 8 known Linux fork warnings | Universal platform/GPU compatibility |
| P0 actual Desktop | Closed-page detached rendering, multimodal host result, ≥20 MiB chunk upload/hash, human-confirmed native Save as | All later UI/agent workflows |
| P1 actual Desktop | Seven built-in diagnostics pass; human-only create/approve/apply; PNG export decoded/checked | P2 agent-to-canvas session |
| P2 isolated integration | All seven tools through real PluginHost, Chromium WebGL, actual compilation/PNG; final browser exit 0 | An LLM session, actual client SDK or human approval |
| P2 human session | Independently verified session `20261111_222455_71cfd9`, agent revisions 28→29→30, exact human-approved tool, current frames and decoded export | Artistic quality or all future workflows |
| P3 final delivery | Exact final local-Git install and validation record: `BUILD-LOG.md`, `evidence/p3-final-install.json` | Publication or catalog acceptance |

The eight warnings arise from `fork()` in a multithreaded Linux test process. They remain visible; do not rewrite that record as warning-free. The P2 harness initially failed cleanup because Node stdin remained open; the saved final rerun fixed stdin lifecycle and exited 0. That rerun is the passing evidence, not a relabeling of the earlier failure.

Relevant recorded evidence names (maintained by the parent outside this docs-only worktree):

- `p0-runtime-verification.{json,txt}`, `p0-client-report.json`.
- `p1-runtime-verification.json`, `p1-runtime-after-client.txt`, plus the human-provided screenshots/confirmation.
- `p2-parent-suite.txt`, `p2-node-final.txt`, `p2-host-integration.{json,txt}`, `p2-validate-installed.txt`.

Some runtime evidence files and generated test images are intentionally not distributed with the package. These names identify the development record, not promises of public download links. README screenshots are real user-provided P1 captures, cropped to omit surrounding navigation/server paths; publication still requires the author's explicit approval. See also `evidence/p2-runtime-verification.json` for the independently correlated real P2 session.

### Reproducing development checks

From a development checkout with its existing test dependencies available:

```bash
PYTHONDONTWRITEBYTECODE=1 python scripts/run_tests.py -p no:cacheprovider
node tests/p1-diagnostics-headless.mjs
python tests/probe_p2_host.py
hermes plugins validate /absolute/path/to/the/exact/package
```

These commands are provided for maintainers, **not rerun by the P3 documentation worker**. The headless checks need their browser tooling; they are not runtime dependencies. Use isolated data roots for integration tests and avoid touching a real project. For already-provisioned temporary-HERMES_HOME host checks, the recorded harness used `HERMES_DISABLE_LAZY_INSTALLS=1` to prevent environment bootstrapping; this is a test control, not a user setting.

Readable bundle rebuild, only if developing source:

```bash
npx --yes esbuild@0.28.2 hermes/plugin.jsx --bundle --format=esm \
  --jsx=automatic --external:@hermes/plugin-sdk --external:react \
  --external:react/jsx-runtime --outfile=desktop/plugin.js
```

Before closing P3, the parent must validate the final manifest/catalog artifact and install its exact local Git commit into an isolated temporary `HERMES_HOME`, then read back plugin inventory. Successful CLI validation is independent of actual renderer execution.

P2 closure matched the fresh session's real tool-call arguments/results with `commands.jsonl` command ids, project identity, predecessor/new revisions, render request/response metadata and fully decoded export. A cached frame, direct Python invocation or headless PASS is not a substitute. The read-only audit is reproducible with `python tests/verify_p2_runtime.py` against the original development data root.

## References

- [Hermes Desktop Plugin SDK](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk/)
- [Build a Hermes Plugin](https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/)
- CLI source of truth: `hermes plugins --help`, `hermes plugins install --help`, `hermes plugins enable --help`, `hermes plugins validate --help`.

The install draft uses actual supported `file://`, `--ref` and `--enable` syntax. No public owner/repository URL is asserted to exist. Publication remains a separate, explicitly authorized human step.
