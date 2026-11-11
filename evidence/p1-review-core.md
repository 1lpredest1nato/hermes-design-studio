# P1 independent core review

Reviewed the live uncommitted P1 source against `../hermes-design-plugin/BUILD-BRIEF.md` and `P1-CONTRACT.md`, on top of P0 commit `d74e984`. No implementation changes made.

## Blocker: optimistic concurrency does not identify the project

**Location:** `studio_core/projects.py:107-112` (new project resets revision to zero and changes the shared pointer), `134-145` (apply loads whichever project is current and compares only its numeric revision), and `234-245` (undo/redo have the same missing identity check).

**Impact:** A pending command from a previous project can silently edit a newly created, different project when their revision numbers match. Two windows/processes are enough; flock serializes the operations but does not protect against this stale-project request. This is not a rejected stale revision or an explicit switch of the caller's document: the old caller receives success, and its node is written into the other project's durable history. Undo/redo can likewise target the wrong project when revisions match.

**Executed reproduction** (from repository root; writes only isolated scratch data):

```python
import tempfile
from pathlib import Path
from studio_core.catalog import Catalog
from studio_core.projects import ProjectStore

root = Path(tempfile.mkdtemp(prefix='p1-review-'))
catalog = Catalog(root, Path('tools/builtin'))
a, b = ProjectStore(root, catalog), ProjectStore(root, catalog)
old = a.new()                       # window A observes old project, revision 0
new = b.new()                       # window B creates another project, revision 0
result = a.apply(old['revision'], [
    {'type': 'add_node', 'tool': 'builtin/pixelate@1',
     'uid': 'stale-old-project-node'}
])
assert result['document']['id'] == new['id']
assert b.get()['stack'][0]['uid'] == 'stale-old-project-node'
```

**Actual observed output:**

```text
old_id: 6a6e858f105543f685610cfdd4592e00
new_id: 0df11ca5dfda4c1cb6e46ededc64dcbe
submitted_base_revision: 0
actual_target_id: 0df11ca5dfda4c1cb6e46ededc64dcbe
actual_target_revision: 1
new_project_stack: [{'uid': 'stale-old-project-node', 'tool': 'builtin/pixelate@1', 'params': {'size': 8}, 'enabled': True, 'opacity': 1.0, 'blend': 'normal'}]
```

**Recommended fix:** Require the expected `project_id` alongside `base_revision` on apply, undo, redo and recipe-apply. Under the existing project lock, compare both against the current document before validation/commit; return `Conflict(current_document)` if either differs. Carry the same identity through API/UI requests. Add a regression test with two stores and a new-project switch, asserting rejection and no project/log mutation. This requires extending the working seam: the current contract's revision-only signature cannot distinguish these two requests. Retain per-project revision 0 for new projects rather than silently violating that requirement.

## Verification and limits

- Read `studio_core/projects.py`, `tests/test_projects.py`, `studio_core/catalog.py`, `core/renderer.mjs`, `core/diagnostics.mjs`, the seven builtin shader/manifest/fixture sets, and renderer/diagnostics acceptance tests; inspected the actual git status and renderer/metrics diff.
- `python scripts/run_tests.py --python-only -k 'project or catalog' -p no:cacheprovider`: **190 passed, 25 deselected**, 30.86 seconds. This selector also includes matching integration/API test names, not only the two core test files.
- `node tests/p1-render-headless.mjs`: exit 0; every reported check passed, including source top-down orientation, straight-alpha readback, PNG/CanvasImageSource checks, five uniform types, blend modes, program cache version/hash changes, source errors and resource cleanup.
- `node tests/p1-diagnostics-headless.mjs`: exit 0; seven builtin checks passed against independent CPU references; all seven fixed fixtures passed; deliberately broken pixelate shader was detected (`mutation_detected: true`). Both browser runs used standalone Chromium 155.0.8059.84 with software WebGL2, not the installed Hermes runtime.
- No additional concrete renderer/diagnostics blocker reproduced. Existing tests do not exercise project identity in concurrency; their cross-process writer test stays inside one current project.
- Initial direct `python -m pytest` could not import pytest. Used the repository's existing dependency-cache-aware test runner; nothing installed.
