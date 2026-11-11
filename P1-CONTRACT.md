# P1 integration contract (authoritative working seam)

All changes only within project; parent owns dashboard/plugin_api.py, __init__.py, studio_core/bridge.py, hermes/service.mjs, hermes/plugin.jsx and integration tests/build/install/log/commits. Agents do NOT commit/install/restart/publish. Deadline first implementations 19:55, review/integration by20:20, human handoff by20:35 (P1 cutoff21:15). TDD sequential RED/GREEN required. Existing P0 runtime proof preserved.

## Python interfaces

### studio_core/projects.py
`ProjectStore(root, catalog)` where catalog is `Catalog` below.
- get() -> document (format1; projects/<id>/project.json; current-project.json pointer)
- new() -> document, starts revision0, source:null, stack:[], timeline:null.
- apply(base_revision, commands, source='ui', gesture_id=None, project_id=None) -> {document,command_id,base_revision,revision}; project_id REQUIRED for mutation, validated with revision under lock (P1 review safety correction).
- undo(base_revision, source='ui', project_id=None), redo(...) -> same envelope; identity required.
- Conflict exception exposes `.document`; backend maps409 + {error,document}.
- commands `type`: add_node {tool,params?,uid?,index?}; remove_node {uid}; move_node {uid,index}; set_params {uid,params}; set_node {uid,enabled?,opacity?,blend?}; set_source {source:{asset,w,h}}; set_seed {seed}; apply_recipe {stack:[node specs]}. No agent/UI JS command logic.
- Catalog.resolve(ref) validates approved tool refs, params types/ranges/defaults validated via catalog.validate_params(ref,params).
- Document includes last_command_id if useful. Durable commands.jsonl per project and global plugin-data commands.jsonl for correlation; backend source ui|agent, revision monotonically increases INCLUDING undo/redo. Gesture merging only contiguous same gesture/source/project; new edit clears redo. Atomic whole batch, cross-process flock.

### studio_core/catalog.py
`Catalog(root,builtin_root)` no Hermes imports, runtime data only root.
- list() -> {tools:[{manifest,shader,status:'builtin'|'approved',ref}],drafts:[{manifest,shader,status:'draft',ref}],recipes:[...]}
- resolve(ref) -> {manifest,shader,status,ref}; unknown versions/format errors readable, no deletion. draft NOT resolvable for project stack.
- validate_params(ref,params) -> normalized validated params with defaults.
- create_draft(name,description,params,shader,author='user',from_prompt='') -> draft entry, stable slug, draft same name updated and compilation invalidated. IDs `user/<slug>`; paths drafts/<slug>.
- record_check(id,shader_sha,result) -> draft with compile result tied exact hash.
- approve_draft(id) -> approved entry, only after success check exact shader hash. Increment approved version (first approval version1 acceptable then2). Parent exposes ONLY UI endpoint, no agent tool.
- delete_draft(id).
- save_recipe(name,stack,exposed=[]) -> recipe; list_recipes(); get_recipe(id). format1 subchain; exposed descriptors {name,node_uid,param}; frozen tool version refs.
- validate_shader(shader) static checker exported: <=32KiB UTF8, no while/do (strip comments), conservative for loop literal0 bound<=256, reject unsupported loop forms/preprocessor directives/backslash trick. No security guarantees against GPU hangs. Params float/int/bool/color/enum; safe uniform names, duplicates/reserved rejected.

## JS core interface (core/renderer.mjs)
`createRenderer(canvas)` -> existing .render(doc,0,options), .dispose(), maxTextureSize, info.
- .render(doc,0,{kind:'preview'|'export',max_size?:1600,tools:[catalog entries],source?:CanvasImageSource|{rgba:Uint8Array,width,height},previous?:{rgba,width,height}}) -> Promise {blob,width,height,metrics,rgba,fixture:false}.
- Source null: generate built-in studio test image (not claim imported image).
- `tools` entries match Catalog.list().tools format. Cache shader programs id/version/hash; per-node opacity/blend; pingpong. Color uniforms convert sRGB hex to linear0..1 as brief.
- Expose .checkTool(entry,{source?,params?}) -> compile + render preview with errors GLSL line info (throws readable on error). Parent/service can use .render with temporary one-node test doc instead if needed.
- Export `runDiagnostics(renderer,tools)` from core/diagnostics.mjs -> {pass,checks:[{tool,pass,...}],...} using actual rendered fixed fixture independently expected pixels. Seven builtins each checked. No GPU hang tests.
- `tools/builtin/<name>/manifest.json`, `shader.frag` maintained by renderer agent, plus fixed fixtures data JSON (not binary payload).

## HTTP API (parent)
GET /state -> {document,pending,latest,catalog:{tools,drafts,recipes}}
POST /project/new -> {document}; POST /commands {project_id,base_revision,commands,gesture_id?} -> envelope; POST /history/undo|redo {project_id,base_revision}; GET /catalog.
POST /drafts {name,description,params,shader} -> draft entry; POST /drafts/check {id} -> creates kind check request, returns request_id; POST /drafts/approve {id} -> approved tool only after exact hash check result; DELETE /drafts?id=...
POST /recipes {name,stack,exposed?}; GET /recipes; POST /recipes/apply {id,project_id,base_revision}.
POST /diagnostics JSON -> persist diagnostics.json; GET /diagnostics.
P0 upload/render request/response/cache/report routes retained; GET /assets/<sha>.png returns binary via ctx.rest (client response format inspect SDK, may base64 wrapper; parent service handles).
Request kind check includes entry, shader_sha,id,document. Failed compile response JSON POST /render/error?id=... with {error,shader_sha}, persisted response error, marks draft check false.

## UI module (hermes/studio-page.jsx)
Export `StudioPage({service,ctx})` and `DiagnosticsPage({service,ctx})`. Parent imports them in register. Page route lifetime .page(bool). Service API:
- .rest(path,opts), .report(fields), .signal, .renderer, .metadata(), .render(doc,time=0,options), .subscribe/.getSnapshot.
- NEW .getState() -> GET /state; .renderProject(document,{kind='preview',toolOverride?,params?,fixture?}) -> full frame, fetches catalog/assets; queue+disposal.
- .saveLibrary(document) -> request export then poll GET /render/result?id=... or direct render+POST /render/response; parent implements.
- .checkDraft(entry,{fixture?:true,params?:...}) -> POST drafts/check then local render request service response; returns frame and compile result. Parent integrates exact details; UI may call service.renderProject with toolOverride and temporary doc to preview.
- .diagnostics() -> run actual core diagnostic then POST /diagnostics, return report.
Native theme only --ui-*; Minimal custom tokens scoped root, ctx.storage theme; ResizeObserver own canvas only; SDK Button/Input/Textarea/Tabs/Select etc preferred. Sidebar operation stack, center preview fit/100% and hold comparison, right tools/recipes/drafts. Params generated manifest; throttled commands15/s gesture ID and 409 recovery. Draft editor GLSL+parameter rows, compile debounce, exact errors+preview on current/test, human-only approve/delete. Keybinds mount-scoped via KEYBINDS_AREA (parent can wire using exported page callbacks if needed). Two export paths: user download link prepared fullres blob; library server export. Image import decode shows immediately then chunk upload; set_source only via backend command. Server path labels distinct.
