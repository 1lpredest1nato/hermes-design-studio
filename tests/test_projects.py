"""Project command contract; all persistence stays in pytest's scratch root."""
import importlib
import json
import multiprocessing
import os
from pathlib import Path

import pytest


class LocalCatalog:
    """Small real catalogue implementing the P1 seam, without Hermes imports."""

    def resolve(self, ref):
        if ref != "builtin/pixelate@1":
            raise ValueError("unknown approved tool reference")
        return {"ref": ref, "status": "builtin", "manifest": {
            "format": 1, "id": "builtin/pixelate", "version": 1,
            "params": [{"name": "size", "type": "int", "min": 1,
                        "max": 64, "default": 8}]}}

    def validate_params(self, ref, params):
        self.resolve(ref)
        if not isinstance(params, dict) or set(params) - {"size"}:
            raise ValueError("unknown parameter")
        size = params.get("size", 8)
        if type(size) is not int or not 1 <= size <= 64:
            raise ValueError("size must be an integer in 1..64")
        return {"size": size}


def store(root):
    module = importlib.import_module("studio_core.projects")
    return module.ProjectStore(root, LocalCatalog())


@pytest.mark.parametrize('history_steps', [0, 1, 2])
@pytest.mark.parametrize("action", ["apply", "undo", "redo", "recipe"])
def test_stale_project_same_revision_is_rejected_without_any_mutation(tmp_path, action, history_steps):
    from studio_core.projects import Conflict
    first, second = store(tmp_path), store(tmp_path)
    old = first.new()
    if history_steps:
        old = first.apply(0, [{'type': 'add_node', 'tool': 'builtin/pixelate@1'}],
                          project_id=old['id'])['document']
    if history_steps == 2:
        old = first.undo(1, project_id=old['id'])['document']
    current = second.new()
    if history_steps:
        current = second.apply(0, [{'type': 'add_node', 'tool': 'builtin/pixelate@1'}],
                               project_id=current['id'])['document']
    if history_steps == 2:
        current = second.undo(1, project_id=current['id'])['document']
    assert old['revision'] == current['revision'] == history_steps
    before = {str(p.relative_to(tmp_path)): p.read_bytes()
              for p in tmp_path.rglob('*') if p.is_file()}
    with pytest.raises(Conflict) as exc:
        if action in ('apply', 'recipe'):
            command = ({'type': 'add_node', 'tool': 'builtin/pixelate@1', 'uid': 'stale'}
                       if action == 'apply' else {'type': 'apply_recipe', 'stack': [
                           {'tool': 'builtin/pixelate@1'}]})
            first.apply(old['revision'], [command], project_id=old['id'])
        else:
            getattr(first, action)(old['revision'], project_id=old['id'])
    assert exc.value.document == current
    assert second.get() == current
    assert {str(p.relative_to(tmp_path)): p.read_bytes()
            for p in tmp_path.rglob('*') if p.is_file()} == before


@pytest.mark.parametrize('action', ['apply', 'undo', 'redo'])
@pytest.mark.parametrize('identity', [None, '', 7])
def test_mutations_require_explicit_project_identity(tmp_path, action, identity):
    projects = store(tmp_path)
    doc = projects.new()
    args = (0, [{'type': 'set_seed', 'seed': 1}]) if action == 'apply' else (0,)
    with pytest.raises(ValueError, match='project_id'):
        getattr(projects, action)(*args, project_id=identity)
    with pytest.raises(ValueError, match='project_id'):
        getattr(projects, action)(*args)
    assert projects.get() == doc
    assert not (tmp_path / 'commands.jsonl').exists()


def test_new_project_is_persisted_and_get_returns_detached_document(tmp_path):
    projects = store(tmp_path)
    doc = projects.new()
    assert doc["format"] == 1
    assert doc["revision"] == 0
    assert doc["source"] is None
    assert doc["stack"] == []
    assert doc["timeline"] is None
    assert type(doc["seed"]) is int
    path = tmp_path / "projects" / doc["id"] / "project.json"
    assert json.loads(path.read_text()) == doc
    assert (tmp_path / "current-project.json").is_file()
    doc["stack"].append({"bad": True})
    assert store(tmp_path).get()["stack"] == []
    second = projects.new()
    assert second["id"] != doc["id"]
    assert projects.get() == second
    assert path.exists()


def test_add_node_resolves_defaults_and_persists_correlated_logs(tmp_path):
    projects = store(tmp_path)
    doc = projects.new()
    command = {"type": "add_node", "tool": "builtin/pixelate@1", "uid": "n1"}
    result = projects.apply(0, [command], source="agent", project_id=projects.get()["id"])
    assert result["base_revision"] == 0
    assert result["revision"] == 1
    assert result["command_id"]
    node = result["document"]["stack"][0]
    assert node == {"uid": "n1", "tool": "builtin/pixelate@1", "params": {"size": 8},
                    "enabled": True, "opacity": 1.0, "blend": "normal"}
    assert result["document"]["last_command_id"] == result["command_id"]
    assert store(tmp_path).get() == result["document"]
    logs = [tmp_path / "commands.jsonl",
            tmp_path / "projects" / doc["id"] / "commands.jsonl"]
    for path in logs:
        records = [json.loads(line) for line in path.read_text().splitlines()]
        assert len(records) == 1
        assert records[0]["id"] == result["command_id"]
        assert records[0]["project_id"] == doc["id"]
        assert records[0]["source"] == "agent"
        assert records[0]["base_revision"] == 0
        assert records[0]["revision"] == 1
    assert command == {"type": "add_node", "tool": "builtin/pixelate@1", "uid": "n1"}


def _compete(root, ready, start, results):
    projects = store(root)
    project_id = projects.get()["id"]
    ready.put(True)
    start.wait(10)
    try:
        result = projects.apply(0, [{"type": "add_node", "tool": "builtin/pixelate@1"}], project_id=project_id)
        results.put(("ok", result["document"]))
    except Exception as exc:
        results.put((type(exc).__name__, getattr(exc, "document", None)))


def test_cross_process_writers_get_one_commit_and_one_conflict(tmp_path):
    projects = store(tmp_path)
    projects.new()
    context = multiprocessing.get_context("fork")
    ready, results, start = context.Queue(), context.Queue(), context.Event()
    workers = [context.Process(target=_compete, args=(tmp_path, ready, start, results))
               for _ in range(2)]
    for worker in workers:
        worker.start()
    try:
        for _ in workers:
            assert ready.get(timeout=10)
        start.set()
        outcomes = [results.get(timeout=10) for _ in workers]
    finally:
        for worker in workers:
            worker.join(10)
            if worker.is_alive():
                worker.kill()
                worker.join()
    assert sorted(kind for kind, _ in outcomes) == ["Conflict", "ok"]
    assert all(doc == projects.get() for _, doc in outcomes)
    assert projects.get()["revision"] == 1
    assert len((tmp_path / "commands.jsonl").read_text().splitlines()) == 1


def test_edit_batch_moves_removes_and_updates_nodes_and_project_fields(tmp_path):
    projects = store(tmp_path)
    projects.new()
    first = projects.apply(0, [{"type": "add_node", "tool": "builtin/pixelate@1", "uid": uid}
                               for uid in ("a", "b", "c")], project_id=projects.get()["id"])
    source = {"asset": "assets/" + "a" * 64 + ".png", "w": 1600, "h": 1000}
    result = projects.apply(first["revision"], [
        {"type": "move_node", "uid": "c", "index": 0},
        {"type": "remove_node", "uid": "b"},
        {"type": "set_params", "uid": "a", "params": {"size": 12}},
        {"type": "set_node", "uid": "c", "enabled": False, "opacity": 0.4, "blend": "screen"},
        {"type": "set_source", "source": source},
        {"type": "set_seed", "seed": 1234},
    ], project_id=projects.get()["id"])
    doc = result["document"]
    assert result["revision"] == 2
    assert [node["uid"] for node in doc["stack"]] == ["c", "a"]
    assert doc["stack"][1]["params"] == {"size": 12}
    assert doc["stack"][0]["enabled"] is False
    assert doc["stack"][0]["opacity"] == 0.4
    assert doc["stack"][0]["blend"] == "screen"
    assert doc["source"] == source
    assert doc["seed"] == 1234
    assert store(tmp_path).get() == doc


@pytest.mark.parametrize("invalid", [
    {"type": "add_node", "tool": "draft/not-approved@1"},
    {"type": "add_node", "tool": "builtin/pixelate@1", "uid": "a"},
    {"type": "add_node", "tool": "builtin/pixelate@1", "index": -1},
    {"type": "add_node", "tool": "builtin/pixelate@1", "params": {"size": True}},
    {"type": "set_params", "uid": "a", "params": {"size": 99}},
    {"type": "set_params", "uid": "a", "params": {"nonsense": 1}},
    {"type": "set_node", "uid": "a", "opacity": float("nan")},
    {"type": "set_node", "uid": "a", "opacity": 1.1},
    {"type": "set_node", "uid": "a", "enabled": 1},
    {"type": "set_node", "uid": "a", "blend": "invalid"},
    {"type": "set_node", "uid": "a", "tool": "other"},
    {"type": "move_node", "uid": "a", "index": 5},
    {"type": "remove_node", "uid": "missing"},
    {"type": "set_source", "source": {"asset": "../escape.png", "w": 1, "h": 1}},
    {"type": "set_source", "source": {"asset": "assets/" + "a"*64 + ".png", "w": 0, "h": 1}},
    {"type": "set_seed", "seed": True},
    {"type": "set_seed", "seed": 1.5},
    {"type": "set_seed"},
    {"type": "unknown"},
    {},
    None,
])
def test_invalid_second_command_rolls_back_whole_batch(tmp_path, invalid):
    projects = store(tmp_path)
    projects.new()
    before = projects.apply(0, [{"type": "add_node", "tool": "builtin/pixelate@1", "uid": "a"}], project_id=projects.get()["id"])["document"]
    logs = (tmp_path / "commands.jsonl").read_bytes()
    with pytest.raises(ValueError):
        projects.apply(1, [{"type": "set_seed", "seed": 999}, invalid], project_id=projects.get()["id"])
    assert projects.get() == before
    assert store(tmp_path).get() == before
    assert (tmp_path / "commands.jsonl").read_bytes() == logs


def test_undo_redo_reopen_restore_whole_batches_with_increasing_revisions(tmp_path):
    projects = store(tmp_path)
    original = projects.new()
    edited = projects.apply(0, [
        {"type": "add_node", "tool": "builtin/pixelate@1", "uid": "a"},
        {"type": "set_seed", "seed": 42},
    ], project_id=projects.get()["id"])["document"]
    undone = store(tmp_path).undo(1, source="agent", project_id=store(tmp_path).get()["id"])
    assert undone["revision"] == 2
    assert undone["base_revision"] == 1
    assert undone["document"]["stack"] == original["stack"]
    assert undone["document"]["seed"] == original["seed"]
    redone = store(tmp_path).redo(2, project_id=store(tmp_path).get()["id"])
    assert redone["revision"] == 3
    assert redone["document"]["stack"] == edited["stack"]
    assert redone["document"]["seed"] == 42
    assert redone["command_id"] != undone["command_id"]
    assert projects.get() == redone["document"]
    Conflict = importlib.import_module("studio_core.projects").Conflict
    with pytest.raises(Conflict) as exc:
        projects.undo(1, project_id=projects.get()["id"])
    assert exc.value.document == redone["document"]
    with pytest.raises(ValueError, match="redo"):
        projects.redo(3, project_id=projects.get()["id"])
    assert projects.get() == redone["document"]
    records = [json.loads(line) for line in (tmp_path / "commands.jsonl").read_text().splitlines()]
    assert [r["revision"] for r in records] == [1, 2, 3]
    assert [r["action"] for r in records] == ["apply", "undo", "redo"]


def test_only_contiguous_same_source_gestures_merge_and_new_edit_clears_redo(tmp_path):
    projects = store(tmp_path)
    projects.new()
    def edit(revision, seed, gesture, source="ui"):
        return store(tmp_path).apply(revision, [{"type": "set_seed", "seed": seed}],
                                     source=source, gesture_id=gesture, project_id=store(tmp_path).get()["id"])
    edit(0, 1, "drag")
    edit(1, 2, "drag")
    assert projects.undo(2, project_id=projects.get()["id"])["document"]["seed"] == 0
    assert projects.redo(3, project_id=projects.get()["id"])["document"]["seed"] == 2
    edit(4, 3, "drag")  # redo interrupted the gesture
    assert projects.undo(5, project_id=projects.get()["id"])["document"]["seed"] == 2
    edit(6, 4, "drag")  # clears redo; undo also interrupted the gesture
    with pytest.raises(ValueError, match="redo"):
        projects.redo(7, project_id=projects.get()["id"])
    edit(7, 5, "drag", source="agent")  # source differs
    assert projects.undo(8, project_id=projects.get()["id"])["document"]["seed"] == 4
    edit(9, 6, "other")
    edit(10, 7, "drag")
    assert projects.undo(11, project_id=projects.get()["id"])["document"]["seed"] == 6
    assert projects.undo(12, project_id=projects.get()["id"])["document"]["seed"] == 4
    assert projects.undo(13, project_id=projects.get()["id"])["document"]["seed"] == 2
    assert projects.undo(14, project_id=projects.get()["id"])["document"]["seed"] == 0
    with pytest.raises(ValueError, match="undo"):
        projects.undo(15, project_id=projects.get()["id"])


def test_recipe_expands_frozen_nodes_with_fresh_uids_as_one_history_step(tmp_path):
    projects = store(tmp_path)
    projects.new()
    recipe = [{"uid": "a", "tool": "builtin/pixelate@1", "params": {"size": 3},
               "enabled": False, "opacity": 0.5, "blend": "multiply"},
              {"uid": "b", "tool": "builtin/pixelate@1"}]
    expected_recipe = json.loads(json.dumps(recipe))
    command = {"type": "apply_recipe", "stack": recipe}
    first = projects.apply(0, [command], project_id=projects.get()["id"])["document"]
    second = projects.apply(1, [command], project_id=projects.get()["id"])["document"]
    assert len(second["stack"]) == 4
    assert len({node["uid"] for node in second["stack"]}) == 4
    assert all(node["uid"] not in ("a", "b") for node in second["stack"])
    for node in (second["stack"][0], second["stack"][2]):
        assert node["params"] == {"size": 3}
        assert node["enabled"] is False
        assert node["opacity"] == 0.5
        assert node["blend"] == "multiply"
    assert second["stack"][1]["params"] == {"size": 8}
    assert recipe == expected_recipe
    assert projects.undo(2, project_id=projects.get()["id"])["document"]["stack"] == first["stack"]
    assert projects.redo(3, project_id=projects.get()["id"])["document"]["stack"] == second["stack"]
    with pytest.raises(ValueError):
        projects.apply(4, [{"type": "apply_recipe", "stack": [recipe[0],
                       {"tool": "draft/not-approved@1"}]}], project_id=projects.get()["id"])
    assert projects.get()["stack"] == second["stack"]


@pytest.mark.parametrize("target", ["project", "pointer", "journal"])
def test_unknown_storage_formats_are_rejected_without_deleting_data(tmp_path, target):
    projects = store(tmp_path)
    doc = projects.new()
    projects.apply(0, [{"type": "set_seed", "seed": 1}], project_id=projects.get()["id"])
    paths = {"project": tmp_path / "projects" / doc["id"] / "project.json",
             "pointer": tmp_path / "current-project.json",
             "journal": tmp_path / "commands.jsonl"}
    path = paths[target]
    value = json.loads(path.read_text())
    value["format"] = 99
    damaged = json.dumps(value) + ("\n" if target == "journal" else "")
    path.write_text(damaged)
    with pytest.raises(ValueError, match="format"):
        store(tmp_path).get()
    assert path.read_text() == damaged


def test_pointer_cannot_escape_project_root(tmp_path):
    projects = store(tmp_path)
    projects.new()
    path = tmp_path / "current-project.json"
    path.write_text(json.dumps({"format": 1, "id": "../outside"}))
    with pytest.raises(ValueError, match="id"):
        projects.get()


def _crash_after_durable_global_append(root):
    ProjectStore = importlib.import_module("studio_core.projects").ProjectStore
    class CrashingStore(ProjectStore):
        def _append(self, path, record):
            super()._append(path, record)
            if path == self.root / "commands.jsonl":
                os._exit(73)
    CrashingStore(root, LocalCatalog()).apply(0, [{"type": "set_seed", "seed": 123}], project_id=CrashingStore(root, LocalCatalog()).get()["id"])


def test_global_journal_recovers_process_death_before_project_materialization(tmp_path):
    projects = store(tmp_path)
    doc = projects.new()
    child = multiprocessing.get_context("fork").Process(
        target=_crash_after_durable_global_append, args=(tmp_path,))
    child.start()
    child.join(10)
    assert child.exitcode == 73
    reopened = store(tmp_path)
    recovered = reopened.get()
    assert recovered["revision"] == 1
    assert recovered["seed"] == 123
    project_dir = tmp_path / "projects" / doc["id"]
    assert json.loads((project_dir / "project.json").read_text()) == recovered
    assert (project_dir / "commands.jsonl").read_bytes() == (tmp_path / "commands.jsonl").read_bytes()
    assert reopened.undo(1, project_id=reopened.get()["id"])["document"]["seed"] == 0
    assert store(tmp_path).get()["revision"] == 2
    assert len((tmp_path / "commands.jsonl").read_text().splitlines()) == 2


def test_uncommitted_partial_journal_tail_is_discarded_before_next_transaction(tmp_path):
    projects = store(tmp_path)
    projects.new()
    projects.apply(0, [{"type": "set_seed", "seed": 1}], project_id=projects.get()["id"])
    journal = tmp_path / "commands.jsonl"
    with journal.open("ab") as handle:
        handle.write(b'{"format": 1, "id": "torn')
    assert store(tmp_path).get()["seed"] == 1
    assert projects.apply(1, [{"type": "set_seed", "seed": 2}], project_id=projects.get()["id"])["revision"] == 2
    assert [json.loads(line)["revision"] for line in journal.read_text().splitlines()] == [1, 2]


@pytest.mark.parametrize("kwargs", [
    {"base_revision": True}, {"base_revision": -1}, {"base_revision": 0.0},
    {"source": "untrusted"}, {"gesture_id": ""}, {"gesture_id": 3},
    {"commands": []}, {"commands": None}, {"commands": {}},
])
def test_invalid_batch_metadata_is_rejected_without_a_commit(tmp_path, kwargs):
    projects = store(tmp_path)
    doc = projects.new()
    arguments = {"project_id": doc["id"], "base_revision": 0, "commands": [{"type": "set_seed", "seed": 1}]}
    arguments.update(kwargs)
    with pytest.raises(ValueError):
        projects.apply(**arguments)
    assert projects.get() == doc
    assert not (tmp_path / "commands.jsonl").exists()


def test_real_catalog_defaults_patch_validation_and_saved_recipe_compatibility(tmp_path):
    from studio_core.catalog import Catalog
    from studio_core.projects import ProjectStore
    catalog = Catalog(tmp_path, Path(__file__).resolve().parents[1] / "tools" / "builtin")
    projects = ProjectStore(tmp_path, catalog)
    projects.new()
    edited = projects.apply(0, [{"type": "add_node", "tool": "builtin/levels@1", "uid": "levels"}], project_id=projects.get()["id"])
    initial_params = edited["document"]["stack"][0]["params"]
    assert len(initial_params) > 1
    patched = projects.apply(1, [{"type": "set_params", "uid": "levels", "params": {"brightness": 0.2}}], project_id=projects.get()["id"])
    assert patched["document"]["stack"][0]["params"] == {**initial_params, "brightness": 0.2}
    recipe = catalog.save_recipe("Levels chain", patched["document"]["stack"])
    applied = projects.apply(2, [{"type": "apply_recipe", "stack": catalog.get_recipe(recipe["id"])["stack"]}], project_id=projects.get()["id"])
    assert len(applied["document"]["stack"]) == 2
    assert applied["document"]["stack"][1]["params"] == {**initial_params, "brightness": 0.2}
    for params in ({"brightness": True}, {"gamma": -1}, {"unknown": 1}):
        with pytest.raises(ValueError):
            projects.apply(3, [{"type": "set_params", "uid": "levels", "params": params}], project_id=projects.get()["id"])
    assert projects.get() == applied["document"]


@pytest.mark.parametrize("link_target", ["root", "lock", "projects", "pointer", "global_log", "project", "project_log"])
def test_symlinked_storage_cannot_read_or_write_outside_root(tmp_path, link_target):
    outside = tmp_path / "outside"
    outside.mkdir()
    root = tmp_path / "data"
    if link_target == "root":
        root.symlink_to(outside, target_is_directory=True)
        with pytest.raises(ValueError, match="symlink"):
            store(root).get()
        assert list(outside.iterdir()) == []
        return
    projects = store(root)
    doc = projects.new()
    projects.apply(0, [{"type": "set_seed", "seed": 1}], project_id=projects.get()["id"])
    directory = root / "projects" / doc["id"]
    target = {"lock": root / ".projects.lock", "projects": root / "projects",
              "pointer": root / "current-project.json", "global_log": root / "commands.jsonl",
              "project": directory / "project.json", "project_log": directory / "commands.jsonl"}[link_target]
    content = None
    if target.is_dir():
        saved = root / "saved-projects"
        target.rename(saved)
        target.symlink_to(outside, target_is_directory=True)
    else:
        content = target.read_bytes()
        target.unlink()
        (outside / "target").write_bytes(content)
        target.symlink_to(outside / "target")
    with pytest.raises(ValueError, match="symlink"):
        projects.get()
    if (outside / "target").exists():
        assert (outside / "target").read_bytes() == content


@pytest.mark.parametrize("command", [
    {"type": "add_node", "tool": "builtin/pixelate@1", "uid": "bad uid"},
    {"type": "set_node", "uid": "a", "opacity": 10**400},
])
def test_node_validation_handles_catalog_incompatible_uids_and_huge_numbers(tmp_path, command):
    projects = store(tmp_path)
    projects.new()
    before = projects.apply(0, [{"type": "add_node", "tool": "builtin/pixelate@1", "uid": "a"}], project_id=projects.get()["id"])["document"]
    with pytest.raises(ValueError):
        projects.apply(1, [command], project_id=projects.get()["id"])
    assert projects.get() == before


def test_commit_fsyncs_global_journal_directory_entry(tmp_path, monkeypatch):
    projects = store(tmp_path)
    projects.new()
    synced = []
    real_fsync = os.fsync
    def recording_fsync(fd):
        synced.append(os.fstat(fd).st_ino)
        return real_fsync(fd)
    monkeypatch.setattr(os, "fsync", recording_fsync)
    projects.apply(0, [{"type": "set_seed", "seed": 1}], project_id=projects.get()["id"])
    assert tmp_path.stat().st_ino in synced


def test_new_project_fsyncs_project_directory_before_publishing_pointer(tmp_path, monkeypatch):
    projects = store(tmp_path)
    synced = []
    real_fsync = os.fsync
    def recording_fsync(fd):
        synced.append(os.fstat(fd).st_ino)
        return real_fsync(fd)
    monkeypatch.setattr(os, "fsync", recording_fsync)
    projects.new()
    assert (tmp_path / "projects").stat().st_ino in synced


def test_malformed_format_one_pointer_raises_readable_validation_error(tmp_path):
    projects = store(tmp_path)
    projects.new()
    pointer = tmp_path / "current-project.json"
    pointer.write_text('{"format": 1}')
    with pytest.raises(ValueError, match="pointer"):
        projects.get()
    assert pointer.read_text() == '{"format": 1}'


def test_gesture_history_is_isolated_between_projects(tmp_path):
    projects = store(tmp_path)
    first = projects.new()
    projects.apply(0, [{"type": "set_seed", "seed": 1}], gesture_id="same", project_id=projects.get()["id"])
    second = projects.new()
    assert first["id"] != second["id"]
    projects.apply(0, [{"type": "set_seed", "seed": 2}], gesture_id="same", project_id=projects.get()["id"])
    assert projects.undo(1, project_id=projects.get()["id"])["document"]["seed"] == 0
    assert projects.get()["id"] == second["id"]
    with pytest.raises(ValueError, match="undo"):
        projects.undo(2, project_id=projects.get()["id"])
    assert json.loads((tmp_path / "projects" / first["id"] / "project.json").read_text())["seed"] == 1
