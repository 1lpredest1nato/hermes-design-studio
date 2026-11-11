"""P2 adapter contract tests; all state is isolated from user plugin-data."""
import base64
import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=')


def test_preview_rejects_unknown_args_and_preserves_multimodal_seam(adapter, monkeypatch):
    module, app = adapter
    app.bridge.cache_preview(PNG, 0, {'metrics': {'fixture_only': True}})
    monkeypatch.setattr(app.bridge, 'wait', lambda request_id, timeout=10: None)
    result = module.preview({'max_size': 12})
    assert result['_multimodal'] is True and result['metrics'] == {'fixture_only': True}
    assert base64.b64decode(result['content'][1]['image_url']['url'].split(',')[1]) == PNG
    assert result['path'] in result['text_summary'] and 'vision_analyze' in result['text_summary']
    for bad in ({'approve': True}, [], None, {'max_size': True}, {'max_size': 1601}):
        assert json.loads(module.preview(bad))['error']



@pytest.fixture
def adapter(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('p2_agent_adapter', ROOT / '__init__.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    app = module.Application(tmp_path / 'plugin-data')
    monkeypatch.setattr(module, 'get_application', lambda: app, raising=False)
    monkeypatch.setattr(module, 'get_store', lambda: app.bridge)
    return module, app


NAMES = ['design_studio_catalog', 'design_studio_project', 'design_studio_apply',
         'design_studio_preview', 'design_studio_create_tool', 'design_studio_recipe', 'design_studio_export']


@pytest.mark.parametrize('handler,args', [
    ('apply', {'project_id': 'not-an-id', 'base_revision': 0, 'commands': [{'type': 'set_seed', 'seed': 1}]}),
    ('apply', {'project_id': 'a' * 32, 'base_revision': True, 'commands': [{'type': 'set_seed', 'seed': 1}]}),
    ('apply', {'project_id': 'a' * 32, 'base_revision': 0, 'commands': []}),
    ('recipe', {'action': 'apply', 'id': 'recipe/test', 'project_id': 'wrong', 'base_revision': 0}),
    ('recipe', {'action': 'save', 'name': 'Test', 'stack': [], 'exposed': None}),
    ('create_tool', {'name': 'Test', 'description': '', 'params': None, 'shader': 'void main(){}'}),
])
def test_bad_outer_argument_types_fail_before_application_io(adapter, monkeypatch, handler, args):
    module, app = adapter

    def forbidden():
        raise AssertionError('invalid outer arguments must not open application storage')

    monkeypatch.setattr(module, 'get_application', forbidden)
    result = json.loads(getattr(module, handler)(args))
    assert result['status'] == 400 and result['error']


def test_registration_exact_seven_strict_schemas_and_bundled_skill_without_data_io(adapter, monkeypatch):
    module, app = adapter
    tools, skills = [], []

    class Context:
        def register_tool(self, **kwargs):
            tools.append(kwargs)

        def register_skill(self, name, path):
            skills.append((name, path))

    def forbidden(*args, **kwargs):
        raise AssertionError('registration must not open plugin-data')

    monkeypatch.setattr(module, 'get_application', forbidden)
    monkeypatch.setattr(module, 'get_store', forbidden)
    module.register(Context())
    assert [tool['name'] for tool in tools] == NAMES
    assert skills == [('usage', ROOT / 'skills' / 'usage' / 'SKILL.md')]
    assert all(tool['toolset'] == 'design_studio' for tool in tools)
    for tool in tools:
        schema = tool['schema']
        assert schema['name'] == tool['name']
        assert schema['parameters']['additionalProperties'] is False
        assert set(schema['parameters'].get('required', [])) <= schema['parameters']['properties'].keys()
        assert callable(tool['handler'])
    manifest = (ROOT / 'plugin.yaml').read_text()
    assert [line.strip()[2:] for line in manifest.splitlines() if line.strip().startswith('- design_studio_')] == NAMES
    assert next(tool for tool in tools if tool['name'] == module.TOOL_NAME)['schema'] is module.SCHEMA


@pytest.mark.parametrize('outcome', ['pending', 'success', 'failed'])
def test_export_is_an_export_receipt_never_cached_preview(adapter, monkeypatch, outcome):
    module, app = adapter
    app.bridge.cache_preview(PNG, 0, {'metrics': {'cached': True}})
    seen = []

    def wait(request_id, timeout=10):
        assert timeout <= 10
        request = json.loads((app.root / 'requests' / (request_id + '.json')).read_text())
        seen.append(request)
        if outcome == 'success':
            return app.respond(request_id, PNG, {})
        if outcome == 'failed':
            return app.fail(request_id, 'export GPU failure')
        return None

    monkeypatch.setattr(app.bridge, 'wait', wait)
    result = json.loads(module.export({'format': 'png'}))
    assert len(seen) == 1 and seen[0]['kind'] == 'export'
    assert result['request_id'] == seen[0]['request_id']
    if outcome == 'success':
        assert Path(result['path']).parent == app.root / 'exports'
        assert Path(result['path']).read_bytes() == PNG
        assert result['width'] == result['height'] == 1
        assert result['sha256'] == __import__('hashlib').sha256(PNG).hexdigest()
    elif outcome == 'pending':
        assert result['pending'] is True and 'path' not in result
    else:
        assert result['error'] == 'export GPU failure' and 'path' not in result
    assert json.loads(module.export({'format': 'jpeg'}))['error']


def test_recipe_save_list_apply_reuses_core_and_preserves_descriptors(adapter):
    module, app = adapter
    doc = app.projects.get()
    applied = app.projects.apply(0, [{'type': 'add_node', 'tool': 'builtin/pixelate@1',
                                      'uid': 'pixel', 'params': {}}], project_id=doc['id'])
    exposed = [{'name': 'Scale', 'node_uid': 'pixel', 'param': 'size'}]
    saved = json.loads(module.recipe({'action': 'save', 'name': 'My Chain', 'exposed': exposed}))
    assert saved['stack'] == applied['document']['stack'] and saved['exposed'] == exposed
    assert json.loads(module.recipe({'action': 'list'})) == [saved]
    result = json.loads(module.recipe({'action': 'apply', 'id': saved['id'],
                                      'project_id': doc['id'], 'base_revision': 1}))
    assert len(result['document']['stack']) == 2
    record = json.loads((app.root / 'commands.jsonl').read_text().splitlines()[-1])
    assert record['source'] == 'agent' and record['commands'] == [
        {'type': 'apply_recipe', 'stack': saved['stack']}]
    stale = json.loads(module.recipe({'action': 'apply', 'id': saved['id'],
                                     'project_id': doc['id'], 'base_revision': 1}))
    assert stale['status'] == 409 and stale['current'] == result['document']
    assert json.loads(module.recipe({'action': 'save', 'name': 'Explicit', 'stack': saved['stack']}))['id'] == 'recipe/explicit'
    for bad in ({'action': 'apply', 'id': saved['id']}, {'action': 'list', 'name': 'ignored'},
                {'action': 'save', 'name': 'Bad', 'stack': []}, {'action': 'approve'}):
        assert json.loads(module.recipe(bad))['error']


@pytest.mark.parametrize('outcome', ['pending', 'success', 'failed'])
def test_create_tool_checks_exact_agent_draft_and_never_approves(adapter, monkeypatch, outcome):
    module, app = adapter
    original = app.check_draft
    checked = []

    def check(id, **kwargs):
        checked.append((id, kwargs))
        return original(id, **kwargs)

    def wait(request_id, timeout=10):
        assert 0 <= timeout <= 10
        if outcome == 'pending':
            return None
        if outcome == 'failed':
            return app.fail(request_id, 'fixture compiler failure')
        return app.respond(request_id, PNG, {'metrics': {'fixture_only': True}})

    monkeypatch.setattr(app, 'check_draft', check)
    monkeypatch.setattr(app.bridge, 'wait', wait)
    document = app.projects.get()
    value = module.create_tool({'name': 'Agent Draft', 'description': 'test shader',
                                'params': [], 'shader': 'void main(){outColor=vec4(1.0);}'})
    result = value if isinstance(value, dict) else json.loads(value)
    draft = app.catalog.list()['drafts'][0]
    assert draft['manifest']['provenance']['author'] == 'agent'
    assert checked == [(draft['manifest']['id'], {
        'fixture': True, 'expected_shader_sha': draft['expected_shader_sha'],
        'expected_manifest_sha': draft['expected_manifest_sha']})]
    assert result['draft_id'] == 'user/agent-draft' and result['ref'] == draft['ref']
    assert result['needs_human_approval'] is True
    assert app.projects.get() == document
    assert not list((app.root / 'tools').glob('*/*/manifest.json'))
    request = json.loads((app.root / 'requests' / (result['request_id'] + '.json')).read_text())
    assert request['kind'] == 'check' and request['fixture'] is True
    if outcome == 'success':
        assert result['_multimodal'] is True and result['compilation'] == 'passed'
        assert result['metrics'] == {'fixture_only': True}
        assert result['path'] in result['text_summary'] and 'fixture_only' in result['text_summary']
        assert base64.b64decode(result['content'][1]['image_url']['url'].split(',')[1]) == PNG
        assert draft['check']['result']['ok'] is True
    elif outcome == 'pending':
        assert result['pending'] is True and result['compilation'] == 'pending'
        assert '_multimodal' not in result and 'metrics' not in result
        assert draft['check'] is None
    else:
        assert result['error'] == 'fixture compiler failure' and result['compilation'] == 'failed'
        assert '_multimodal' not in result and 'metrics' not in result
        assert draft['check']['result']['ok'] is False


def test_real_import_helper_composes_with_project_adapter(adapter, tmp_path):
    module, app = adapter
    path = tmp_path / 'source.png'
    path.write_bytes(PNG)
    result = json.loads(module.project({'action': 'import_image', 'path': str(path)}))
    assert result['document'] == app.projects.get()
    assert result['document']['source']['w'] == result['document']['source']['h'] == 1
    assert (app.root / result['document']['source']['asset']).read_bytes() == PNG
    assert path.read_bytes() == PNG
    assert result['command_id'] == app.projects.get()['last_command_id']


@pytest.mark.parametrize('bad', [
    {'shader': 'void main(){while(true){}}'},
    {'params': [{'name': 'tint', 'type': 'color', 'default': 'blue'}]},
    {'params': [{'name': 'steps', 'type': 'int', 'min': 1, 'max': 5, 'default': 1.2}]},
    {'params': [{'name': 'mode', 'type': 'enum', 'options': ['one'], 'default': 'other'}]},
])
def test_catalog_rejects_invalid_shader_and_parameter_definitions_through_adapter(adapter, bad):
    module, app = adapter
    args = {'name': 'Bad Draft', 'description': '', 'params': [], 'shader': 'void main(){outColor=vec4(1.0);}'}
    result = json.loads(module.create_tool({**args, **bad}))
    assert result['error'] and result['status'] == 400
    assert app.catalog.list()['drafts'] == []
    assert list((app.root / 'requests').glob('*.json')) == []


def test_import_snapshots_before_io_and_never_retries_conflict(adapter, monkeypatch, tmp_path):
    module, app = adapter
    importer = importlib.import_module(module._core_name + '.import_image')
    before = app.projects.get()
    source = {'asset': 'assets/' + 'a' * 64 + '.png', 'w': 2, 'h': 3,
              'sha256': 'a' * 64, 'bytes': 12}
    calls = []

    def race(root, path):
        calls.append((root, path))
        app.projects.apply(before['revision'], [{'type': 'set_seed', 'seed': 9}],
                           project_id=before['id'])
        return source

    monkeypatch.setattr(importer, 'import_image', race)
    result = json.loads(module.project({'action': 'import_image', 'path': '/server/source.png'}))
    assert result['status'] == 409 and result['current'] == app.projects.get()
    assert len(calls) == 1 and app.projects.get()['source'] is None
    monkeypatch.setattr(importer, 'import_image', lambda root, path: source)
    result = json.loads(module.project({'action': 'import_image', 'path': '/server/source.png'}))
    assert result['document']['source'] == {key: source[key] for key in ('asset', 'w', 'h')}
    row = json.loads((app.root / 'commands.jsonl').read_text().splitlines()[-1])
    assert row['source'] == 'agent' and row['id'] == result['command_id']
    assert json.loads(module.project({'action': 'import_image', 'path': 12}))['error']


def test_apply_is_atomic_agent_authored_and_returns_current_conflict(adapter):
    module, app = adapter
    doc = app.projects.get()
    args = {'project_id': doc['id'], 'base_revision': 0,
            'commands': [{'type': 'set_seed', 'seed': 42}]}
    result = json.loads(module.apply(args))
    assert result['document']['seed'] == 42
    rows = [json.loads(row) for row in (app.root / 'commands.jsonl').read_text().splitlines()]
    assert rows[0]['source'] == 'agent' and rows[0]['id'] == result['command_id']
    for stale in (args, {**args, 'project_id': 'f' * 32, 'base_revision': 1}):
        conflict = json.loads(module.apply(stale))
        assert conflict['status'] == 409 and conflict['current'] == result['document']
    bad = {**args, 'base_revision': 1, 'commands': [
        {'type': 'set_seed', 'seed': 99}, {'type': 'approve'}]}
    assert json.loads(module.apply(bad))['error']
    assert app.projects.get() == result['document']
    assert len((app.root / 'commands.jsonl').read_text().splitlines()) == 1


def test_project_get_new_and_action_validation(adapter):
    module, app = adapter
    first = json.loads(module.project({'action': 'get'}))
    assert first == app.projects.get()
    assert json.loads(module.project({'action': 'get'})) == first
    second = json.loads(module.project({'action': 'new'}))
    assert second['id'] != first['id'] and second['revision'] == 0
    for args in ({'action': 'approve'}, {'action': 'get', 'path': '/unused'}, {}, []):
        assert json.loads(module.project(args))['error']
    assert app.projects.get() == second


def test_catalog_returns_validated_entries_and_filters_case_insensitively(adapter):
    module, app = adapter
    result = json.loads(module.catalog({}))
    assert len(result['tools']) == 7
    assert result['drafts'] == result['recipes'] == []
    assert all(e['manifest']['params'] and e['ref'].startswith('builtin/') for e in result['tools'])
    filtered = json.loads(module.catalog({'query': 'PiXeLaTe'}))
    assert [e['ref'] for e in filtered['tools']] == ['builtin/pixelate@1']
    assert json.loads(module.catalog({'query': 123}))['error']
