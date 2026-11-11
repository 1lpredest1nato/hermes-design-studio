import base64
import importlib.util
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pytest
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=')

def test_requests_are_visible_to_independent_store(tmp_path):
    from studio_core.bridge import Store
    a, b = Store(tmp_path), Store(tmp_path)
    request = a.request('preview', max_size=800)
    state = b.state()
    assert state['document'] == dict(format=1, id='p0', revision=0, source=None, stack=[], seed=1234, timeline=None)
    assert state['pending'] == [request]
    assert request['document'] == state['document']
    assert request['created_at'] > 0
    assert len(request['request_id']) == 32


def test_first_response_wins_across_processes(tmp_path):
    import concurrent.futures
    import multiprocessing
    from studio_core.bridge import Store
    s = Store(tmp_path)
    req = s.request('export')
    ctx = multiprocessing.get_context('fork')
    with concurrent.futures.ProcessPoolExecutor(2, mp_context=ctx) as pool:
        results = list(pool.map(_respond, [(str(tmp_path), req['request_id'], n) for n in (1, 2)]))
    assert results[0] == results[1]
    assert results[0]['revision'] == 0
    assert results[0]['width'] == results[0]['height'] == 1
    assert Path(results[0]['path']).read_bytes() == PNG
    assert results[0]['metrics']['winner'] in (1, 2)
    assert s.wait(req['request_id'], 0) == results[0]
    assert s.state()['pending'] == []


def _respond(args):
    from studio_core.bridge import Store
    root, rid, n = args
    return Store(root).respond(rid, PNG, {'metrics': {'winner': n}})


def test_preview_uses_cached_stale_fallback_and_bounded_wait(tmp_path):
    import time
    from studio_core.bridge import Store
    s = Store(tmp_path)
    cached = s.cache_preview(PNG, revision=0, meta={'metrics': {'mean_luma': 12}})
    s._write(tmp_path / 'document.json', {**s.state()['document'], 'revision': 2})
    started = time.monotonic()
    result = s.preview(timeout=0.02)
    assert time.monotonic() - started < 0.3
    assert result['path'] == cached['path']
    assert result['stale'] is True
    assert result['revision'] == 0
    assert result['requested_revision'] == 2
    assert len(s.state()['pending']) == 1
    # Infinite/nonfinite waits must never slip past the ten-second bound.
    import pytest
    with pytest.raises(ValueError):
        s.wait(s.state()['pending'][0]['request_id'], float('nan'))


def test_chunk_upload_assembles_over_twenty_mb_and_checks_hash(tmp_path):
    import hashlib
    from studio_core.bridge import Store
    s = Store(tmp_path)
    data = PNG + b'x' * (21 * 1024 * 1024)
    sha = hashlib.sha256(data).hexdigest()
    chunks = [data[i:i+4*1024*1024] for i in range(0, len(data), 4*1024*1024)]
    for index in reversed(range(len(chunks))):
        result = s.upload_chunk('abc123', index, len(chunks), sha, chunks[index])
    assert result['sha256'] == sha
    assert result['complete'] is True
    assert Path(result['path']).read_bytes() == data
    assert result['width'] == result['height'] == 1
    with pytest.raises(ValueError, match='hash'):
        s.upload_chunk('def456', 0, 1, '0'*64, PNG)


@pytest.mark.parametrize('id,index,total,sha,data', [
    ('../oops', 0, 1, 'a'*64, PNG), ('abc', -1, 1, 'a'*64, PNG),
    ('abc', 1, 1, 'a'*64, PNG), ('abc', 0, 0, 'a'*64, PNG),
    ('abc', 0, 1, 'z'*64, PNG), ('abc', 0, 1, 'a'*64, b'x'*(4*1024*1024+1)),
] , ids=['bad-id', 'negative-index', 'index-at-total', 'zero-total', 'bad-sha', 'oversize'])
def test_chunk_rejects_unsafe_parameters(tmp_path, id, index, total, sha, data):
    from studio_core.bridge import Store
    with pytest.raises(ValueError):
        Store(tmp_path).upload_chunk(id, index, total, sha, data)


def test_rejects_symlinks_unsafe_ids_and_unbounded_files(tmp_path):
    from studio_core.bridge import Store
    outside = tmp_path / 'outside'
    outside.mkdir()
    root = tmp_path / 'data'
    s = Store(root)
    (root / 'document.json').symlink_to(outside / 'doc.json')
    with pytest.raises(ValueError, match='symlink'):
        s.state()
    (root / 'document.json').unlink()
    (root / 'document.json').write_bytes(b' '* (2*1024*1024+1))
    with pytest.raises(ValueError, match='large'):
        s.state()
    (root / 'document.json').unlink()
    for method in (lambda: s.respond('../escape', PNG, {}), lambda: s.wait('../escape', 0)):
        with pytest.raises(ValueError):
            method()
    (root / 'uploads' / 'abc').symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match='symlink'):
        s.upload_chunk('abc', 0, 1, 'a'*64, PNG)
    assert list(outside.iterdir()) == []
    with pytest.raises(ValueError):
        s.cache_preview(b'not a PNG', 0, {})
    with pytest.raises(ValueError):
        s.cache_preview(PNG, -1, {})
    with pytest.raises(ValueError):
        s.cache_preview(PNG, 0, {'path': 'x', 'metrics': {'bad': float('nan')}})


def test_standalone_dashboard_http_contract(tmp_path, monkeypatch):
    import asyncio
    import hashlib
    import json
    import httpx
    from fastapi import FastAPI
    from studio_core.bridge import Store
    spec = importlib.util.spec_from_file_location('standalone_studio_api', Path(__file__).parents[1] / 'dashboard/plugin_api.py')
    api = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(api)
    monkeypatch.setattr(api, 'get_store', lambda: Store(tmp_path))
    app = FastAPI()
    app.include_router(api.router)
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as c:
            assert (await c.get('/state')).json()['document']['id'] == 'p0'
            req = (await c.post('/render/request', json={'kind':'preview'})).json()
            assert (await c.get('/render/requests')).json()['requests'] == [req]
            response = await c.post('/render/response', params={'id':req['request_id'], 'meta':json.dumps({'metrics':{'mean_luma':42}})}, files={'file':('render.png',PNG,'image/png')})
            assert response.status_code == 200, response.text
            assert response.json()['metrics']['mean_luma'] == 42
            assert (await c.get('/render/requests')).json()['requests'] == []
            cached = await c.post('/preview/cache', params={'revision':0,'meta':'{}'}, files={'file':('p.png',PNG,'image/png')})
            assert cached.status_code == 200
            assert (await c.post('/report', json={'checks':{'a':1}})).status_code == 200
            assert (await c.post('/report', json={'checks':{'b':2}})).status_code == 200
            assert (await c.get('/report')).json()['checks'] == {'a':1,'b':2}
            sha = hashlib.sha256(PNG).hexdigest()
            asset = await c.post('/assets/upload', params={'id':'abcdef','index':0,'total':1,'sha256':sha}, files={'file':('p.png',PNG,'image/png')})
            assert asset.status_code == 200, asset.text
            assert (await c.get('/assets/'+sha+'.png')).content == PNG
            bad = await c.post('/render/response', params={'id':'../bad','meta':'{}'}, files={'file':('p.png',PNG,'image/png')})
            assert bad.status_code == 400
    asyncio.run(run())


def test_preview_adapter_registers_only_preview_and_returns_multimodal(tmp_path, monkeypatch):
    import concurrent.futures
    import json
    import threading
    import time
    from studio_core.bridge import Store
    root = Path(__file__).parents[1]
    spec = importlib.util.spec_from_file_location('studio_adapter_test', root / '__init__.py', submodule_search_locations=[str(root)])
    adapter = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = adapter
    spec.loader.exec_module(adapter)
    monkeypatch.setattr(adapter, 'get_store', lambda: Store(tmp_path))
    registered = []
    class Context:
        def register_tool(self, **kwargs):
            registered.append(kwargs)
    adapter.register(Context())
    assert [tool['name'] for tool in registered] == ['design_studio_preview']
    with concurrent.futures.ThreadPoolExecutor() as pool:
        future = pool.submit(registered[0]['handler'], {'max_size': 800})
        deadline = time.monotonic() + 2
        while not Store(tmp_path).state()['pending'] and time.monotonic() < deadline:
            time.sleep(0.01)
        request = Store(tmp_path).state()['pending'][0]
        Store(tmp_path).respond(request['request_id'], PNG, {'metrics': {'mean_luma': 32, 'almost_uniform': True}, '_multimodal': False, 'content': []})
        result = future.result(timeout=2)
    assert result['_multimodal'] is True
    assert result['content'][1]['image_url']['url'].startswith('data:image/png;base64,')
    summary = result['text_summary']
    assert 'mean_luma' in summary and 'vision_analyze' in summary and '.png' in summary
    assert Path(result['path']).read_bytes() == PNG
    import yaml
    manifest = yaml.safe_load((root / 'plugin.yaml').read_text())
    assert manifest['provides_tools'] == ['design_studio_preview']


def test_late_preview_never_replaces_newer_cache(tmp_path):
    from studio_core.bridge import Store
    s = Store(tmp_path)
    request = s.request('preview')
    s.cache_preview(PNG, 3, {'metrics': {'latest': True}})
    s.respond(request['request_id'], PNG, {'metrics': {'latest': False}})
    assert s.state()['latest']['revision'] == 3


def test_lexical_traversal_is_rejected_even_under_root(tmp_path):
    from studio_core.bridge import Store
    s = Store(tmp_path / 'data')
    (tmp_path / 'secret').write_bytes(b'secret')
    with pytest.raises(ValueError):
        s._bytes(s.root / '..' / 'secret', 100)

