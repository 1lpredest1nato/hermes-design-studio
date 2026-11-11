# Submission kit — unpublished drafts

**Status:** prepared locally, not submitted. No public repository, catalog PR, video URL, X post or form submission is claimed to exist. Publishing, pushing and sending anything require the author's separate explicit authorization. Keep that distinction when copying these drafts.

Author: **1lpredest1nato**. Project: **Hermes Design Studio**. License: **MIT**. AI assistance: **Hermes Agent by Nous Research**.

## Draft catalog PR

### Title

Add Hermes Design Studio: manual and agent-assisted shader image editing

### Description (copy after final verification)

Hermes Design Studio adds a non-destructive image workshop to Hermes Desktop as one unified plugin: an independent Python state core, a WebGL2 rendering/metrics core, and thin Hermes adapters.

Users can work entirely without an agent: upload or drop an image, compose an operation stack, adjust parameters, author GLSL with a parameter-table editor, inspect current-image and fixture previews, explicitly approve a tool, save a recipe and export a PNG. Hermes Native and plugin-scoped Minimal themes change only the interface.

Seven built-ins are included: Pixelate, Ordered Dither, Halftone, Gradient Map, Grain, Chromatic Aberration and Levels. Seven `design_studio_*` tools expose catalog/project access, atomic edits, preview, draft creation/checking, recipes and export. A bundled `hermes-design-studio:usage` skill documents the workflow.

Both UI and agent use backend-owned commands checked by project identity plus revision. Stale edits fail with 409 rather than silently merging or landing in another project. Tool drafts require explicit human approval of the checked source/schema; there is no agent approval tool.

The service renderer runs while a connected Desktop window is open, even when the Studio page is closed. File-backed requests/responses bridge isolated host processes, with events and polling. Preview PNGs also include numerical metrics so a non-vision model can continue with explicitly limited feedback.

### Runtime and safety notes

- Requires a POSIX gateway (`fcntl` locking), Hermes unified Python/Desktop plugin APIs and WebGL2 on the connected Desktop. Windows gateway is unsupported; Linux is the verified backend environment.
- Readable ESM bundle is committed. No runtime plugin Python dependencies, native payloads, WASM, minification or arbitrary HTML/JavaScript tool execution.
- User projects/tools/drafts/recipes/exports live in plugin-data, never the installed code directory.
- Static images only: `timeline: null`, `u_time = 0.0`. Preview longest side ≤1600 px; full-resolution PNG export ≤4096 px per side.
- Static GLSL checks are **not a GPU sandbox** and cannot guarantee protection against expensive shaders or GPU hangs.
- Server-path import supports PNG/JPEG/static WebP **header/metadata checking only**, not full decoding. Client browser decoding remains required. OAuth remote multipart Upload currently requires switching to a gateway-token connection.
- Remote Upload/Save as operate on the client; agent import paths, plugin-data and library exports are on the gateway.

### Verification text — retain the pending items until closed

Recorded code checkpoint `f3aef873e24173a28677c8f28606175762e60b55`: **355 Python tests and 55 JavaScript tests passed**, with **8 known Linux multiprocessing/fork warnings**. P0 and P1 have independently checked actual Desktop evidence, including closed-page rendering, chunked upload/hash, manual authoring/approval, diagnostics for all seven effects and a decoded gateway PNG export.

P2 isolated integration exercised all seven tools through a real PluginHost and Chromium WebGL. Separately, the parent verified actual fresh LLM session `20261111_222455_71cfd9`, source-agent command ids at revisions 28→29→30, human approval of the exact agent-authored snapshot, fresh closed-page client previews and a 1536×1024 export checked with SHA-256 and Pillow. See `evidence/p2-runtime-verification.json`.

P3 final-package validation and isolated local-Git installation are tracked in `BUILD-LOG.md` and `evidence/p3-final-install.json`; use the actual source commit and exit statuses there, not the older P2 checkpoint. These delivery checks do not imply publication or catalog admission.

### AI-assisted development disclosure (copy verbatim or adapt transparently)

> Created by 1lpredest1nato with substantial assistance from Hermes Agent by Nous Research. Hermes Agent assisted with implementation, tests, documentation and code review. The author directed scope and design, performed the manual client workflows and tool approvals, and retains responsibility for review and publication. This is an independent community plugin, not an official Nous Research product or endorsement. Source and documentation are MIT-licensed.

### PR metadata to fill only after publication authorization

- Public source URL: **not created/verified yet**.
- Final release/installation commit (full 40-character SHA): **parent to fill after all delivery changes**, not the older code checkpoint above.
- Catalog PR URL: **not created yet**.
- Exact Hermes requirement and tested build: **copy from the finalized manifest and validation record**; do not infer upstream compatibility from the developer fork's version.
- Final validation log / isolated-install inventory: see `evidence/p3-final-install.json` and `BUILD-LOG.md` for the exact record.
- README screenshot/media: optional real user captures only, after privacy review. No invented screenshot or generated imitation of the UI.

## Draft X post

Plain-text draft, **217 Unicode characters**, calculated with Python `len()`; below the 280-character limit. It contains no nonexistent repository/video link. Recalculate after any edit or addition; platform URL weighting may differ from plain character count.

```text
Hermes Design Studio: a shader workshop inside Hermes Desktop. Edit images by hand or with an agent, approve new tools yourself, save recipes, export PNGs. Built by 1lpredest1nato with Hermes Agent. MIT. @NousResearch
```

**Not posted.** The user owns posting. Add a verified video/repository link only when one exists and after checking the final platform length.

## Video script — 74 seconds

**Not recorded or uploaded.** Record real Desktop interactions; do not simulate tool receipts, approvals, downloads or UI. Use a non-sensitive image and hide private chat, hostnames, tokens and file paths. Prepare the image/project and an unapproved draft before recording so compilation/agent latency does not overrun the slot. If using cuts, show the real sequence and do not imply that asynchronous work happened instantly.

| Time | Duration | Actual screen action | Voice/caption |
|---|---:|---|---|
| 00:00–00:08 | 8 s | Show Design Studio with an image and the full interface. | “Hermes Design Studio is a shader image workshop inside Hermes Desktop.” |
| 00:08–00:20 | 12 s | Upload a public-domain/demo image; add Pixelate or Dither and adjust a slider. | “Use it by hand: import an image and build a non-destructive stack.” |
| 00:20–00:30 | 10 s | Toggle an operation, change blend/opacity, and show before/after. | “The same project keeps revisions, undo and reusable operations.” |
| 00:30–00:44 | 14 s | Show a real agent request and resulting fresh preview; reveal metrics. | “The agent edits the same state. Text metrics also support models without vision.” |
| 00:44–00:56 | 12 s | Open a genuine agent-created draft; show GLSL, parameters and completed checks; human clicks Approve tool. | “Agents can propose shaders. Only you approve the exact checked tool.” |
| 00:56–01:06 | 10 s | Apply that approved version, show changed pixels, then save a recipe. | “Approved tools and frozen recipes stay in your library.” |
| 01:06–01:14 | 8 s | Prepare PNG, show real Save as or gateway export receipt, finish on title/credits. | “Export a PNG. MIT. Built by 1lpredest1nato with Hermes Agent.” |

Durations were summed in Python: **8 + 12 + 10 + 14 + 12 + 10 + 8 = 74 seconds**, with continuous intervals, within the requested 60–80 seconds and under 90 seconds. The final recorded file's duration still needs measurement. Do not claim its timing from this script alone.

If the required genuine new-session evidence is not yet correlated, finish that gate before recording a demo that claims it. The script is not evidence that any action occurred.

## Form / release checklist

### Before any publication

- [x] Parent independently closed P2: actual session/tool calls, commands, exact approved snapshot, client receipts and decoded export correlated.
- [ ] Finalize manifest/tool declarations, truthful Hermes compatibility and catalog draft; retain the eight known test warnings in the record.
- [ ] Run final `hermes plugins validate` against the exact delivery artifact and preserve exit status/output.
- [ ] Install the exact local Git commit into an isolated temporary `HERMES_HOME`; read back plugin inventory/enablement as required. Do not use the live profile to stand in for a clean install.
- [ ] Replace pending verification text only with recorded facts. Fill the final full commit SHA after all changes; do not accidentally submit the pre-P3 checkpoint.
- [ ] Inspect README/links/license/disclosure; review any real screenshots/video for private paths, personal images, chats and credentials.
- [ ] Obtain explicit author authorization for public repository creation, push and catalog PR. Local commits are not publication.

### Publication and form (human/authorized parent, not performed here)

- [ ] Create/publish the actual source repository, then verify its URL and commit remotely.
- [ ] Create the catalog PR against `NousResearch/hermes-agent` with the immutable full SHA; verify the actual PR URL and include disclosure.
- [ ] Record and check the real 60–80 s demo, upload it, and verify playback/accessibility and final duration.
- [ ] Post the approved text mentioning `@NousResearch`; verify its actual URL and final length. No X post has been sent by this task.
- [ ] Open the real submission form and follow its actual required fields; this checklist does not claim knowledge of uninspected field names or acceptance rules.
- [ ] Enter author/contact details personally; use only verified repository/PR/video/post URLs, project name, description and MIT/AI disclosure where requested.
- [ ] Submit before the deadline given in the build brief: **12 November 2026, 01:00 MSK**. Check the live form's rules/deadline if they differ; do not infer submission success from this document.
- [ ] Read back the confirmation/receipt and retain evidence. **Form submission is not yet done.**

## Handoff

This file belongs in the delivery checkout as `SUBMISSION.md`. The build brief also requests a companion submission document in the orchestration directory; this docs-only worker is not authorized to write there. The parent may copy this reviewed draft to that location. No installation, restart, merge, push, repository creation, PR, post, video upload or form submission is performed by this documentation task.
