---
name: usage
description: Use when editing images in Design Studio.
version: 0.1.0
author: 1lpredest1nato, Hermes Agent
license: MIT
platforms: [linux, macos]
metadata:
  hermes:
    tags: [design, images, shaders, revisions]
    related_skills: []
---

# Design Studio usage

Edit a durable image-processing project through the seven `design_studio_*` tools. The Python backend owns commands and history; an open Hermes Desktop window renders WebGL2 frames, including when the Studio page is closed. No vision model is required.

## When to Use

- Inspect or process an image in Hermes Design Studio.
- Create a reusable shader draft or save/apply a frozen recipe.
- Don't use for animation, unrestricted JavaScript/HTML execution, or editing host UI.

## Prerequisites

- Backend plugin and Desktop half enabled; Desktop connected to the same gateway/profile.
- A new agent session after tool registration changes. This skill is `hermes-design-studio:usage`.
- Backend uses POSIX file locking; Windows gateway is not supported by this slice. A remote client and gateway can be different computers.
- For manual operations, the user opens Design Studio. Agent tools are optional; every workflow also has UI controls.

## Quick Reference

| Tool | Use |
|---|---|
| `design_studio_catalog(query?)` | Discover versioned tools, parameter schemas, drafts and recipes. |
| `design_studio_project(action, path?)` | `get`, `new`, or `import_image` from an explicit gateway path. |
| `design_studio_apply(project_id, base_revision, commands)` | One atomic command batch; returns command id and new document. |
| `design_studio_preview(max_size?)` | PNG, metrics and `text_summary`; longest side at most 1600. |
| `design_studio_create_tool(name, description, params, shader)` | Draft, static check and real compilation/fixture preview; never approval. |
| `design_studio_recipe(action, …)` | `save`, `list`, `apply`; apply uses project identity/revision. |
| `design_studio_export(format: "png")` | Actual full-resolution PNG in gateway `exports/`, dimensions and SHA-256. |

## Procedure

1. Call `design_studio_project` with `action:"get"` and inspect `design_studio_catalog`. Reuse existing source unless the user asks for a new project/import. A relative/server path refers to the gateway, not the Desktop laptop. UI Upload reads the client's computer instead. Completion: know the current project id, revision, source and valid tool refs.
2. Build commands using discovered exact refs, e.g. `builtin/pixelate@1`, and manifest parameter ranges. Send `project_id` and `base_revision` from the same document snapshot. Commands are `add_node`, `remove_node`, `move_node`, `set_params`, `set_node`, `set_source`, `apply_recipe`, `set_seed`; their logic lives only in Python. On 409, read the returned current document, reconsider the requested change and retry explicitly if still appropriate. Never silently replay a batch against a different project. Completion: obtain a new revision and `command_id`.
3. Call `design_studio_preview` after changes, before making visual claims. Inspect the image if the active model supports it; otherwise read `text_summary`: dimensions, mean/std luma, clipping percentages, five dominant colors, detail density, source/previous RGB differences and nearly-uniform flag. Missing comparisons are null, not zero. Check `stale`, requested/current revision and project identity. A cached stale image is not proof of the latest command. If useful and available, call `vision_analyze` with the returned server PNG path; don't require it. Completion: fresh frame or explicit disclosure that only stale/pending evidence exists.
4. To author a tool, write the GLSL body below and parameter manifest, then call `design_studio_create_tool`. Inspect actual compile result, errors with line numbers, fixture PNG and metrics. A timeout/pending request is not compilation success. A uniform/black result can be intentional; compare with the requested effect before accepting it. Completion: a checked draft id or a clearly reported failed/pending check.
5. Stop and ask the human to review the draft in **Drafts → Edit**, inspect both previews, and click **Approve tool**. Never approve via terminal, Python, HTTP, or another generic tool; there is deliberately no approval tool. Human approval binds the exact shader and manifest fingerprints displayed; concurrent edits invalidate it. Re-read the catalog afterward and apply the exact approved `user/<slug>@<version>` ref using a fresh project snapshot. Completion: human confirmation plus approved catalog entry and a fresh preview after application.
6. Save a recipe with `name`, ordered `stack` and optional `exposed` descriptors (`name`, `node_uid`, `param`). Use validated node parameters and exact version refs; a recipe freezes this subchain. Apply with `id`, `project_id`, `base_revision`; it appends operations, preserving source. Completion: saved recipe appears in list, and application returns a logged command id.
7. Export only after checking preview. `design_studio_export` writes on the gateway and returns path, dimensions, SHA-256. Full resolution has a 4096-pixel side limit; report larger images honestly, don't silently downscale. User **Prepare PNG → Save as…** saves on the client; **Save to library** saves on the gateway. Completion: actual export receipt, not merely an intended path.

## Shader contract

GLSL ES 3.00 fragment shader; write helper functions and `main()` only. Renderer supplies precision and these declarations:

- `uniform sampler2D u_input; uniform vec2 u_resolution; uniform float u_time; uniform float u_seed;`
- `in vec2 v_uv; out vec4 outColor;`
- Parameters become `p_<name>`: `float`, `int`, `bool`; hex `color` becomes a linear RGB `vec3`; `enum` becomes the integer option index.

Project `timeline` stays null and `u_time` is always 0.0. Seed is backend-owned and makes grain repeatable. Input is sRGB 8-bit straight alpha, render target RGBA8; preserve alpha unless the effect deliberately changes it.

Static validation rejects `while`/`do`, nonliteral or over-256 loop bounds, shader text over 32 KiB, and invalid parameter declarations. These checks are **not a GPU sandbox** or a guarantee against expensive shaders. Do not attempt stress/hang probes.

## Pitfalls

- Draft refs are not approved tools; don't add them to the project. Don't fabricate an approved version after a successful compile.
- Keep identity with revision: unrelated projects can have the same revision number. UI queues bind identity at submission, not dispatch.
- Inspect enabled/opacity/blend and stack order before declaring an effect broken. Grayscale dither after chromatic aberration removes its colored fringes; an unchecked operation is disabled.
- A newly created pass-through shader does not change the image; adding a parameter doesn't use it until GLSL references `p_<name>`.
- Unknown format versions fail clearly without deletion. Don't repair persisted manifests by hand.
- Tool-handler waits are bounded at 10 seconds. No Desktop/renderer means pending/error or explicitly stale preview, never invented pixels.
- Never use general filesystem/HTTP tools to bypass human approval or duplicate core command logic.

## Verification

- Read returned project and command id; distinguish `source:agent` from manual `source:ui` history.
- Match actual tool-call results to `commands.jsonl` ids, project id and backend predecessor/revision when proving agent-to-canvas behavior. Polling may skip intermediate revisions; that alone is not failure.
- A fresh PNG with current metadata is frame evidence. A success label or standalone browser test is not proof that the user's Desktop executed it.
- Report checked image evidence, export receipt and remaining limits. Never claim visual success without preview inspection or honest metric-based qualification.
