# P2 integration seams

P1 closed e11be13; current source is independently reviewed and real-client verified.
Deadline P2 22:30 MSK, feature freeze/P3 23:15. Aim API/tools ready 21:40 for human reload and fresh-session workflow.

## Ownership
- Tool worker: __init__.py, plugin.yaml, tests/test_agent_tools.py, evidence/p2-tools-*. No core/API/UI edits.
- Import worker: studio_core/import_image.py, tests/test_import_image.py, evidence/p2-import-*. No adapter edits.
- Parent: bundled skills, integration/real PluginHost tests, validation/install/log/commits. No other worker commits or installs.

## Image import seam
`studio_core.import_image.import_image(root, path) -> {asset:'assets/<sha>.png',w:int,h:int,sha256:str,bytes:int}`.
Reads an explicit file on gateway; content-addressed copy only inside plugin-data assets, atomic streaming/hash, no arbitrary source writes, no file size ceiling. Runtime stdlib-only; PNG/JPEG mandatory, WebP if feasible; reject unsupported/malformed headers clearly. Source file may be a normal symlink but destination/root must not be symlink/traversal. Do not mutate project. Adapter snapshots project id+revision BEFORE IO then applies single set_source(source=asset,w,h) as source='agent'; reject conflict with current document, never retry automatically. Existing .png suffix is content-addressed storage convention even for JPEG; loadAsset sniffs MIME.

## Seven tools
Register exactly design_studio_catalog, design_studio_project, design_studio_apply, design_studio_preview, design_studio_create_tool, design_studio_recipe, design_studio_export; toolset design_studio, declared provides_tools matches. Preserve TOOL_NAME/SCHEMA/preview/get_store P0 test seams. New get_application() for other adapters is lazy via plugin_data_dir.

- catalog(query?) returns validated manifest params, refs, drafts, recipes; plain case-insensitive text query.
- project(action get|new|import_image,path?) returns document; import returns command_id and authoritative document. Initial project get may lazy-create. Nothing writes at module import/register.
- apply(project_id,base_revision,commands) source agent, atomic; identity+revision safety extension adopted in P1. Conflict JSON includes error,current document,status409. No mutation on stale ID/revision. No agent undo schema required (UI history still core).
- preview existing envelope preserved; max_size 1..1600, <=10s wait and honest cached stale status. Metrics and server path in text_summary; optional auxiliary vision_analyze hint, never require vision.
- create_tool(name,description,params,shader): Catalog.create_draft(author='agent'), then Application.check_draft with exact entry.expected_shader_sha and expected_manifest_sha, fixture=True. Durable check request; <=10s wait. On success return compilation/check/preview with multimodal+text_summary and draft_id/ref, needs_human_approval:true, never approve or add draft to project. Pending/failed compile clearly distinguished; no fake pass. If no renderer, preserve pending draft and request_id. Handler can best-effort broadcast but files/poll are authoritative.
- recipe(action save|apply|list,name?,stack?,exposed?,id?,project_id?,base_revision?): save explicit subchain or default current stack; validated/frozen refs through Catalog.save_recipe. Apply requires project_id+base_revision and core apply_recipe command source agent; exposed params remain descriptors, no duplicate JS/core logic.
- export(format png only) creates export request, <=10s wait, returns actual exports PNG path,w/h,sha; no cached preview masquerading as export.

Handlers return JSON strings for ordinary responses; dict `_multimodal` envelope for preview/check. Errors meaningful, never catch/convert into success. Explicit schema outer additionalProperties false, required args defined; runtime validations also needed because direct callers may bypass schema. UI check/approve fingerprint contract from P1 unchanged, no approval tool or hidden approval endpoint from agent adapter.

## Testing
Strict sequential RED→GREEN saved. Isolated tmp roots only; no real user project mutations for automated tests. Real PluginHost concurrency proof separate from mocked ctx registration. Parent real-client/fresh session proof still requires user action. Full runner `PYTHONDONTWRITEBYTECODE=1 python scripts/run_tests.py`; do not provision global deps or modify Hermes.
