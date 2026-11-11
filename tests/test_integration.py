from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def test_document_provider_drives_snapshot_and_render_request(tmp_path):
    from studio_core.bridge import Store
    doc = {'format':1,'id':'real','revision':7,'source':None,'stack':[],'seed':5,'timeline':None}
    try:
        store = Store(tmp_path, document_provider=lambda: dict(doc))
    except TypeError:
        raise AssertionError('Bridge has no injected authoritative document provider') from None
    assert store.state()['document'] == doc
    request = store.request('preview')
    assert request['document'] == doc
    doc['revision'] = 8
    assert store.state()['document']['revision'] == 8
    assert request['document']['revision'] == 7


def test_renderer_error_completes_request_without_poisoning_preview_cache(tmp_path):
    from studio_core.bridge import Store
    store = Store(tmp_path)
    request = store.request('check', shader_sha='a' * 64)
    assert hasattr(store, 'fail'), 'render bridge cannot persist compiler errors'
    result = store.fail(request['request_id'], 'ERROR: 0:3: unknown symbol', {'shader_sha':'a'*64})
    assert result['error'].startswith('ERROR: 0:3:')
    assert store.wait(request['request_id'], 0) == result
    assert store.state()['pending'] == []
    assert store.state()['latest'] is None
    assert store.fail(request['request_id'], 'later failure', {}) == result


def test_asset_reader_is_bounded_and_checks_names(tmp_path):
    import base64
    import hashlib
    import pytest
    from studio_core.bridge import Store
    store = Store(tmp_path)
    payload = b'\x89PNG\r\n\x1a\nfixture-bytes'
    sha = hashlib.sha256(payload).hexdigest()
    store.upload_chunk('a1', 0, 1, sha, payload)
    assert hasattr(store, 'read_asset'), 'SDK asset read bridge missing'
    part = store.read_asset(sha, 2, 5)
    assert part['offset'] == 2 and part['total'] == len(payload)
    assert base64.b64decode(part['base64']) == payload[2:7]
    assert part['bytes'] == 5 and part['mime'] == 'image/png'
    for args in [('../secret',0,2),(sha,-1,2),(sha,0,1048577),(sha,len(payload),2)]:
        with pytest.raises(ValueError):
            store.read_asset(*args)


def test_preview_cache_never_confuses_equal_revisions_of_different_projects(tmp_path):
    import base64
    from studio_core.bridge import Store
    png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=')
    current = {'format':1,'id':'old','revision':0,'source':None,'stack':[],'seed':1,'timeline':None}
    store = Store(tmp_path, document_provider=lambda: dict(current))
    old = store.request('preview')
    current['id'] = 'new'
    new = store.cache_preview(png,0,{'project_id':'new'})
    store.respond(old['request_id'],png,{'project_id':'forged'})
    assert store.state()['latest']['project_id'] == 'new'
    current['id'] = 'third'
    assert store.preview(timeout=0)['stale'] is True


def test_preview_adapter_uses_authoritative_project_provider(tmp_path, monkeypatch):
    import importlib.util
    import plugins.plugin_storage
    monkeypatch.setattr(plugins.plugin_storage, 'plugin_data_dir', lambda id: tmp_path)
    root = Path(__file__).resolve().parents[1]
    spec = importlib.util.spec_from_file_location('p1_preview_adapter', root / '__init__.py')
    adapter = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(adapter)
    store = adapter.get_store()
    assert store.document_provider is not None, 'Agent preview still reads the P0 fixture document'
    document = store.state()['document']
    assert document['id'] != 'p0' and document['timeline'] is None
    assert (tmp_path / 'projects' / document['id'] / 'project.json').exists()
