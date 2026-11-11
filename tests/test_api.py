"""Real filesystem/ASGI tests; these are not Desktop or GPU evidence."""
import asyncio
import base64
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

import httpx
import pytest
from fastapi import FastAPI

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=')
SHADER = 'void main(){ outColor = texture(u_input, v_uv); }'


def application(root):
    try:
        from studio_core.application import Application
    except ImportError:
        pytest.fail('P1 Application composition is missing')
    return Application(root)


@pytest.fixture
def client(tmp_path, monkeypatch):
    spec = importlib.util.spec_from_file_location('standalone_p1_api', ROOT / 'dashboard/plugin_api.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    app = application(tmp_path)
    monkeypatch.setattr(api, 'get_store', lambda: app.bridge)
    # The adapter's public root provider remains usable independently of Hermes.
    server = FastAPI()
    server.include_router(api.router)
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=server), base_url='http://studio')


@pytest.mark.parametrize('path', ['/commands', '/history/undo', '/history/redo', '/recipes/apply'])
def test_http_stale_project_identity_conflicts_at_equal_revision(client, tmp_path, path):
    async def run():
        async with client as c:
            old = (await c.post('/project/new', json={})).json()['document']
            current = (await c.post('/project/new', json={})).json()['document']
            payload = {'project_id': old['id'], 'base_revision': old['revision']}
            if path == '/commands':
                payload['commands'] = [{'type': 'add_node', 'tool': 'builtin/pixelate@1'}]
            if path == '/recipes/apply':
                saved = await c.post('/recipes', json={'name': 'Identity regression',
                    'stack': [{'uid': 'n', 'tool': 'builtin/pixelate@1'}], 'exposed': []})
                assert saved.status_code == 200, saved.text
                payload['id'] = saved.json()['id']
            assert (await c.get('/state')).json()['document'] == current
            before = {str(p.relative_to(tmp_path)): p.read_bytes()
                      for p in tmp_path.rglob('*') if p.is_file()}
            response = await c.post(path, json=payload)
            assert response.status_code == 409, response.text
            assert response.json()['document'] == current
            assert (await c.get('/state')).json()['document'] == current
            assert {str(p.relative_to(tmp_path)): p.read_bytes()
                    for p in tmp_path.rglob('*') if p.is_file()} == before
            payload.pop('project_id')
            missing = await c.post(path, json=payload)
            assert missing.status_code == 400, missing.text
            assert 'project_id' in missing.json()['detail']
            assert {str(p.relative_to(tmp_path)): p.read_bytes()
                    for p in tmp_path.rglob('*') if p.is_file()} == before
    asyncio.run(run())


def fingerprints(entry):
    from studio_core.catalog import _manifest_sha
    expected = {'expected_shader_sha': hashlib.sha256(entry['shader'].encode()).hexdigest(),
                'expected_manifest_sha': _manifest_sha(entry['manifest'])}
    assert {key: entry[key] for key in expected} == expected
    return {key: entry[key] for key in expected}


@pytest.mark.parametrize('edit', ['shader', 'params'])
def test_http_editor_snapshot_required_before_check_and_human_approval(client, tmp_path, edit):
    async def run():
        async with client as c:
            original = {'name': 'Snapshot', 'description': '', 'params': [], 'shader': SHADER}
            a = (await c.post('/drafts', json=original)).json()
            expected_a = fingerprints(a)
            for path in ['/drafts/check', '/drafts/approve']:
                for missing in [None, 'expected_shader_sha', 'expected_manifest_sha']:
                    payload = {'id': a['manifest']['id'], **expected_a}
                    if missing is None:
                        payload = {'id': a['manifest']['id']}
                    else:
                        payload.pop(missing)
                    response = await c.post(path, json=payload)
                    assert response.status_code == 400, response.text
                    assert 'expected_' in response.json()['detail']
            checked_a = (await c.post('/drafts/check', json={'id': a['manifest']['id'], **expected_a})).json()
            assert (await c.post('/render/response', params={'id': checked_a['request_id']},
                                 files={'file': ('a.png', PNG)})).status_code == 200
            changed = {**original, **({'shader': SHADER + '\n'} if edit == 'shader' else
                       {'params': [{'name': 'toggle', 'type': 'bool', 'default': True}]})}
            b = (await c.post('/drafts', json=changed)).json()
            rejected = await c.post('/drafts/check', json={'id': a['manifest']['id'], **expected_a})
            assert rejected.status_code in (400, 409), rejected.text
            assert 'snapshot' in rejected.text
            assert application(tmp_path).bridge.state()['pending'] == []
            for key, value in fingerprints(b).items():
                assert b[key] == value
            req = (await c.post('/drafts/check', json={'id': b['manifest']['id'], **fingerprints(b)})).json()
            assert req['entry'] == b
            assert (await c.post('/render/response', params={'id': req['request_id']},
                                 files={'file': ('r.png', PNG)})).status_code == 200
            # A newly checked replacement must not inherit the human's old intent.
            old_approval = await c.post('/drafts/approve', json={'id': a['manifest']['id'], **expected_a})
            assert old_approval.status_code in (400, 409), old_approval.text
            assert 'snapshot' in old_approval.text
            assert (await c.post('/drafts/approve', json={'id': b['manifest']['id'], **fingerprints(b)})).status_code == 200
    asyncio.run(run())


def test_http_project_command_history_and_conflict(client, tmp_path):
    async def run():
        async with client as c:
            initial = (await c.get('/state')).json()
            assert 'catalog' in initial, 'P1 state lacks catalog'
            created = await c.post('/project/new', json={})
            assert created.status_code == 200, created.text
            doc = created.json()['document']
            assert doc['id'] != initial['document']['id']
            catalog = (await c.get('/catalog')).json()
            tool = catalog['tools'][0]['ref']
            changed = await c.post('/commands', json={'project_id': doc['id'], 'base_revision': 0, 'commands': [
                {'type': 'add_node', 'tool': tool, 'uid': 'node1'}], 'gesture_id': 'drag'})
            assert changed.status_code == 200, changed.text
            envelope = changed.json()
            assert envelope['document']['stack'][0]['tool'] == tool
            conflict = await c.post('/commands', json={'project_id': doc['id'], 'base_revision': 0, 'commands': [
                {'type': 'set_seed', 'seed': 4}]})
            assert conflict.status_code == 409, conflict.text
            assert conflict.json()['document'] == envelope['document']
            undone = await c.post('/history/undo', json={'project_id': doc['id'], 'base_revision': 1})
            assert undone.status_code == 200, undone.text
            assert undone.json()['document']['stack'] == []
            redone = await c.post('/history/redo', json={'project_id': doc['id'], 'base_revision': 2})
            assert redone.status_code == 200, redone.text
            assert redone.json()['document']['stack'][0]['tool'] == tool
            stale = await c.post('/history/undo', json={'project_id': doc['id'], 'base_revision': 1})
            assert stale.status_code == 409
            assert stale.json()['document']['revision'] == 3
            req = (await c.post('/render/request', json={'kind': 'preview'})).json()
            assert req['document'] == redone.json()['document']
            records = [json.loads(line) for line in (tmp_path / 'commands.jsonl').read_text().splitlines()]
            assert all(record['source'] == 'ui' for record in records)
    asyncio.run(run())


def test_http_draft_check_png_approval_and_delete(client, tmp_path):
    async def run():
        async with client as c:
            draft_response = await c.post('/drafts', json={'name': 'Custom Identity', 'description': 'test',
                                                          'params': [], 'shader': SHADER})
            assert draft_response.status_code == 200, draft_response.text
            draft = draft_response.json()
            ident = draft['manifest']['id']
            assert (await c.post('/drafts/approve', json={'id': ident})).status_code == 400
            check = await c.post('/drafts/check', json={'id': ident, **fingerprints(draft), 'fixture': True, 'params': {}})
            assert check.status_code == 200, check.text
            request = check.json()
            rid = request['request_id']
            assert request['entry'] == draft
            assert request['draft_id'] == request['id'] == ident
            assert request['shader_sha'] == hashlib.sha256(SHADER.encode()).hexdigest()
            assert request['fixture'] is True and request['params'] == {}
            assert request['document'] == (await c.get('/state')).json()['document']
            assert (await c.get('/render/result', params={'id': rid})).json() == {'pending': True}
            forged = {'draft_id': 'user/some-other-tool', 'shader_sha': '0'*64, 'ok': False}
            result = await c.post('/render/response', params={'id': rid, 'meta': json.dumps(forged)},
                                  files={'file': ('check.png', PNG, 'image/png')})
            assert result.status_code == 200, result.text
            assert (await c.get('/render/result', params={'id': rid})).json() == result.json()
            stored = (await c.get('/catalog')).json()['drafts'][0]
            assert stored['check']['result']['ok'] is True
            assert stored['check']['shader_sha'] == request['shader_sha']
            approved = await c.post('/drafts/approve', json={'id': ident, **fingerprints(draft)})
            assert approved.status_code == 200, approved.text
            assert approved.json()['status'] == 'approved'
            assert not (await c.get('/catalog')).json()['drafts']
            assert application(tmp_path).catalog.resolve(approved.json()['ref']) == approved.json()
            await c.post('/drafts', json={'name': 'Delete Me', 'description': '', 'params': [], 'shader': SHADER})
            deleted = await c.delete('/drafts', params={'id': 'user/delete-me'})
            assert deleted.status_code == 200, deleted.text
            assert not (await c.get('/catalog')).json()['drafts']
    asyncio.run(run())


def test_http_compile_error_is_durable_and_first_response_wins(client, tmp_path):
    async def run():
        async with client as c:
            draft = (await c.post('/drafts', json={'name': 'Broken', 'description': '',
                                                  'params': [], 'shader': SHADER})).json()
            ident = draft['manifest']['id']
            req = (await c.post('/drafts/check', json={'id': ident, **fingerprints(draft)})).json()
            rid = req['request_id']
            error = await c.post('/render/error', params={'id': rid}, json={
                'error': 'ERROR: 0:3: bad symbol', 'shader_sha': 'f'*64, 'draft_id': 'user/forged'})
            assert error.status_code == 200, error.text
            assert error.json()['error'] == 'ERROR: 0:3: bad symbol'
            assert (await c.get('/render/result', params={'id': rid})).json() == error.json()
            stored = (await c.get('/catalog')).json()['drafts'][0]
            assert stored['check']['result']['ok'] is False
            assert stored['check']['shader_sha'] == req['shader_sha']
            assert (await c.post('/drafts/approve', json={'id': ident})).status_code == 400
            later = await c.post('/render/response', params={'id': rid}, files={'file': ('r.png', PNG)})
            assert later.status_code == 200 and later.json() == error.json()
            assert application(tmp_path).catalog.list()['drafts'][0]['check']['result']['ok'] is False
            good_req = (await c.post('/drafts/check', json={'id': ident, **fingerprints(draft)})).json()
            good = await c.post('/render/response', params={'id': good_req['request_id']},
                                files={'file': ('r.png', PNG)})
            duplicate = await c.post('/render/error', params={'id': good_req['request_id']},
                                     json={'error': 'late failure'})
            assert duplicate.json() == good.json()
            assert (await c.get('/catalog')).json()['drafts'][0]['check']['result']['ok'] is True
    asyncio.run(run())


def test_raw_render_request_cannot_forge_compile_approval(client):
    async def run():
        async with client as c:
            draft = (await c.post('/drafts', json={'name': 'Target', 'description': '',
                                                  'params': [], 'shader': SHADER})).json()
            forged = await c.post('/render/request', json={'kind': 'check', 'draft_id': 'user/target',
                'entry': draft, 'shader_sha': hashlib.sha256(SHADER.encode()).hexdigest()})
            assert forged.status_code == 400, 'Raw client payload can impersonate a trusted check request'
            assert (await c.post('/drafts/approve', json={'id': 'user/target'})).status_code == 400
    asyncio.run(run())


def test_http_asset_read_json_chunks_preserve_p0_binary(client):
    async def run():
        async with client as c:
            sha = hashlib.sha256(PNG).hexdigest()
            uploaded = await c.post('/assets/upload', params={'id': 'abc', 'index': 0,
                'total': 1, 'sha256': sha}, files={'file': ('a.png', PNG)})
            assert uploaded.status_code == 200, uploaded.text
            chunk = await c.get('/assets/read', params={'sha': sha, 'offset': 2, 'length': 7})
            assert chunk.status_code == 200, chunk.text
            assert chunk.json() == {'offset': 2, 'total': len(PNG), 'bytes': 7,
                'mime': 'image/png', 'base64': base64.b64encode(PNG[2:9]).decode()}
            assert (await c.get('/assets/' + sha + '.png')).content == PNG
            assert (await c.get('/assets/read', params={'sha': sha, 'offset': -1})).status_code == 400
            assert (await c.get('/assets/read', params={'sha': '../bad'})).status_code == 400
    asyncio.run(run())


def test_http_recipes_frozen_stack_exposed_and_revision_conflict(client, tmp_path):
    async def run():
        async with client as c:
            doc = (await c.get('/state')).json()['document']
            tool = next(t for t in (await c.get('/catalog')).json()['tools']
                        if t['manifest']['params'])
            param = tool['manifest']['params'][0]
            exposed = [{'name': 'control', 'node_uid': 'n1', 'param': param['name']}]
            stack = [{'uid': 'n1', 'tool': tool['ref'], 'params': {},
                      'enabled': False, 'opacity': .4, 'blend': 'screen'}]
            saved = await c.post('/recipes', json={'name': 'Frozen', 'stack': stack, 'exposed': exposed})
            assert saved.status_code == 200, saved.text
            recipe = saved.json()
            assert recipe['exposed'] == exposed
            assert recipe['stack'][0]['tool'] == tool['ref']
            assert (await c.get('/recipes')).json() == {'recipes': [recipe]}
            assert application(tmp_path).catalog.get_recipe(recipe['id']) == recipe
            bad = await c.post('/recipes', json={'name': 'Bad', 'stack': stack,
                'exposed': [{'name': 'missing', 'node_uid': 'bad', 'param': param['name']}]})
            assert bad.status_code == 400
            applied = await c.post('/recipes/apply', json={'project_id': doc['id'], 'id': recipe['id'], 'base_revision': 0})
            assert applied.status_code == 200, applied.text
            nodes = applied.json()['document']['stack']
            assert [{k: v for k, v in n.items() if k != 'uid'} for n in nodes] == [
                {k: v for k, v in n.items() if k != 'uid'} for n in recipe['stack']]
            conflict = await c.post('/recipes/apply', json={'project_id': doc['id'], 'id': recipe['id'], 'base_revision': 0})
            assert conflict.status_code == 409, conflict.text
            assert conflict.json()['document'] == applied.json()['document']
    asyncio.run(run())


def test_http_diagnostics_durable_json_and_invalid_body(client, tmp_path):
    async def run():
        async with client as c:
            initial = await c.get('/diagnostics')
            assert initial.status_code == 200, initial.text
            assert initial.json() == {}
            report = {'pass': False, 'checks': [{'tool': 'builtin/grain@1', 'pass': False}],
                      'renderer': {'fixture': False, 'error': 'real diagnostic failure'}}
            saved = await c.post('/diagnostics', json=report)
            assert saved.status_code == 200 and saved.json() == report
            assert json.loads((tmp_path / 'diagnostics.json').read_text()) == report
            assert (await c.get('/diagnostics')).json() == report
            assert (await c.post('/diagnostics', content='[]')).status_code == 400
            assert (await c.post('/diagnostics', content='{"pass":NaN}')).status_code == 400
            assert (await c.get('/diagnostics')).json() == report
    asyncio.run(run())


def test_application_check_schema_edit_between_snapshot_and_record_cannot_approve(tmp_path, monkeypatch):
    app = application(tmp_path)
    app.catalog.create_draft('Race', '', [], SHADER)
    req = app.check_draft('user/race')
    record = app.catalog.record_check
    def interleaved(*args, **kwargs):
        app.catalog.create_draft('Race', '', [{'name': 'gain', 'type': 'float',
            'min': 0, 'max': 2, 'default': 1}], SHADER)
        return record(*args, **kwargs)
    monkeypatch.setattr(app.catalog, 'record_check', interleaved)
    # Transport receipt remains valid, but edited schema must stay unapproved.
    receipt = app.respond(req['request_id'], PNG, {})
    assert receipt['request_id'] == req['request_id']
    assert app.catalog.list()['drafts'][0]['check'] is None
    with pytest.raises(ValueError, match='check'):
        app.catalog.approve_draft('user/race')


def test_http_project_mutations_broadcast_only_after_success_and_best_effort(client, monkeypatch):
    import types
    events = []
    module = types.ModuleType('hermes_cli.plugin_events')
    def broadcast(plugin, event, document):
        events.append((plugin, event, document))
        if document['revision'] == 2:
            raise RuntimeError('notification transport unavailable')
    module.broadcast_plugin_event = broadcast
    monkeypatch.setitem(sys.modules, 'hermes_cli.plugin_events', module)
    async def run():
        async with client as c:
            created = await c.post('/project/new', json={})
            assert created.status_code == 200
            doc = created.json()['document']
            assert events == [('hermes-design-studio', 'doc.changed', created.json()['document'])]
            changed = await c.post('/commands', json={'project_id': doc['id'], 'base_revision': 0,
                'commands': [{'type': 'set_seed', 'seed': 4}]})
            assert changed.status_code == 200
            assert events[-1][2] == changed.json()['document']
            count = len(events)
            assert (await c.post('/commands', json={'project_id': doc['id'], 'base_revision': 0,
                'commands': [{'type': 'set_seed', 'seed': 5}]})).status_code == 409
            assert len(events) == count
            undone = await c.post('/history/undo', json={'project_id': doc['id'], 'base_revision': 1})
            assert undone.status_code == 200
            assert events[-1][2] == undone.json()['document']
            redone = await c.post('/history/redo', json={'project_id': doc['id'], 'base_revision': 2})
            assert redone.status_code == 200
            assert events[-1][2] == redone.json()['document']
    asyncio.run(run())


@pytest.mark.parametrize('edit', ['shader', 'schema', 'delete'])
def test_http_stale_compile_response_never_approves_edited_draft(client, tmp_path, edit):
    async def run():
        async with client as c:
            original = {'name': 'Stale', 'description': '', 'params': [], 'shader': SHADER}
            draft = (await c.post('/drafts', json=original)).json()
            requested = await c.post('/drafts/check', json={'id': 'user/stale', **fingerprints(draft),
                'entry': {'manifest': {}}, 'shader_sha': '0'*64, 'document': {'revision': 999}})
            assert requested.status_code == 200, requested.text
            req = requested.json()
            assert req['entry'] == draft
            assert req['document'] == (await c.get('/state')).json()['document']
            if edit == 'delete':
                assert (await c.delete('/drafts', params={'id': 'user/stale'})).status_code == 200
            else:
                updated = dict(original)
                if edit == 'shader':
                    updated['shader'] += '\n'
                else:
                    updated['params'] = [{'name': 'toggle', 'type': 'bool', 'default': True}]
                assert (await c.post('/drafts', json=updated)).status_code == 200
            receipt = await c.post('/render/response', params={'id': req['request_id']},
                                   files={'file': ('r.png', PNG)})
            assert receipt.status_code == 200, receipt.text
            assert (await c.post('/drafts/approve', json={'id': 'user/stale'})).status_code == 400
            current = application(tmp_path).catalog.list()['drafts']
            assert current == [] if edit == 'delete' else current[0]['check'] is None
    asyncio.run(run())


def test_application_composes_durable_authoritative_state(tmp_path):
    app = application(tmp_path)
    state = app.state()
    assert set(state) == {'document', 'pending', 'latest', 'catalog'}
    assert state['document'] == app.projects.get()
    assert len(state['catalog']['tools']) == 7
    doc = app.projects.apply(0, [{'type': 'set_seed', 'seed': 123}], project_id=state['document']['id'])['document']
    request = app.bridge.request('preview')
    assert request['document'] == doc
    assert application(tmp_path).state()['document'] == doc
    assert app.bridge.root == tmp_path
    assert (tmp_path / 'current-project.json').is_file()
