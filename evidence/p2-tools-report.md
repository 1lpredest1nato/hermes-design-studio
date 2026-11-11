# P2 tool adapter evidence (worker self-report, not real-client proof)

Owned changes: `__init__.py`, `plugin.yaml`, `tests/test_agent_tools.py`, `evidence/p2-tools-*` only. No installation, restart, commit, global configuration/dependency change, or real user plugin-data mutation.

## Delivered

Exactly seven registered agent tools and matching provides_tools: catalog, project, apply, preview, create_tool, recipe, export. Existing TOOL_NAME/SCHEMA/preview/get_store seams retained. Native usage skill registration added; parent owns its file. Plugin-data access remains lazy.

Adapters compose Application/Catalog/ProjectStore/bridge. Runtime outer argument validation fails closed. apply/import/recipe mutations are agent-authored, atomic core commands; stale identity/revision returns status 409 with authoritative current/document. Import snapshots before helper IO, with no retry. Drafts use author agent and fixture check with both exact backend fingerprints; pending, compile error, and PNG receipt success remain distinct. No approval tool or approval call. PNG receipt success preserves multimodal payload and receipt metrics in text_summary. Export returns actual export request receipt, not cached preview.

## Sequential RED → GREEN

Each numbered pair contains the actual test output from before and after the corresponding production change:

1. `p2-tools-01-catalog-{red,green}.log`
2. `p2-tools-02-project-{red,green}.log`
3. `p2-tools-03-apply-{red,green}.log`
4. `p2-tools-04-import-{red,green}.log`
5. `p2-tools-05-preview-{red,green}.log`
6. `p2-tools-06-create-{red,green}.log`
7. `p2-tools-07-recipe-{red,green}.log`
8. `p2-tools-08-export-{red,green}.log`
9. `p2-tools-09-registration-{red,green}.log`
10. `p2-tools-10-validation-{red,green}.log`

Additional characterization tests exercise the real stdlib import helper end-to-end and existing Catalog rejection of malformed shader/color/int/enum definitions; no production changes were needed for these existing core behaviors. Test renderer receipts/metrics are explicitly synthetic test fixtures, not GPU/client evidence.

## Verification

- `PYTHONDONTWRITEBYTECODE=1 python scripts/run_tests.py --python-only -k test_agent_tools`: **24 passed**, 330 deselected; `p2-tools-adapter-final.log`.
- Full runner before final five characterization cases and parent's new skill test: **349 Python passed + 49 JS passed**; `p2-tools-full-final.log`.
- Latest full runner: **354 Python passed, 1 failed**; `p2-tools-full-verified.log`. The sole failure is parent-owned `tests/test_usage_skill.py::test_bundled_usage_skill_frontmatter_and_safety_contract`, because parent-owned `skills/usage/SKILL.md` did not exist at execution time. Runner stops before JS on Python failure. No adapter failures. Parent is implementing this skill separately.
- Eight multiprocessing fork DeprecationWarnings arise in existing cross-process tests under Python 3.14; no adapter warnings.
- `git diff --check`: clean.

## Remaining boundaries

Parent must finish bundled usage skill, rerun full suite, verify real PluginHost/concurrency and fresh-session client workflow, and handle deployment. This report is not client proof. Nothing here auto-approves a draft or writes the active user's project.
