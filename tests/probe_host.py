"""P0 integration probe using the REAL Hermes PluginHost, not a mock.

This is not a real Desktop run and does not claim Electron/ctx.rest proof.
The image is an explicitly generated test fixture, not an application result.
No gateway restart, installed config mutation, or other plugin loading.
"""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlencode
import hashlib
import io
import json
import os
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PIL import Image
from hermes_constants import set_hermes_home_override
from hermes_cli.plugins import PluginManager, PluginContext, parse_manifest_file
from hermes_cli.plugin_host import PluginHost
from tools.registry import registry

HOME = ROOT / 'evidence' / 'host-home'
HOME.mkdir(parents=True, exist_ok=True)
os.environ['HERMES_HOME'] = str(HOME)
# Temporary homes otherwise trigger managed-dependency provisioning/re-exec at
# child bootstrap. Use the existing interpreter unchanged for this probe.
os.environ['HERMES_DISABLE_LAZY_INSTALLS'] = '1'
set_hermes_home_override(HOME)
manager = PluginManager(scope_key=str(HOME))
host = PluginHost(manager)
manifest = parse_manifest_file(ROOT / 'plugin.yaml', ROOT, 'user', '')
assert manifest is not None
context = PluginContext(manifest, manager)
report = {'kind': 'real-plugin-host-integration-secondary-not-desktop', 'parent_pid': os.getpid()}


def http(method, path, query=None, body=b'', content_type='application/json'):
    response = host.asgi_request('hermes-design-studio', str(ROOT / 'dashboard'), 'plugin_api.py',
        method, path, urlencode(query or {}), [['content-type', content_type]], body,
        timeout=20, authenticated=True)
    if response['status'] >= 400:
        raise AssertionError(f"{method} {path}: {response['status']} {response['body']!r}")
    return json.loads(response['body'])


def multipart(payload):
    boundary = 'studio-' + uuid.uuid4().hex
    prefix = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="probe.png"\r\n'
              'Content-Type: image/png\r\n\r\n').encode()
    return prefix + payload + f'\r\n--{boundary}--\r\n'.encode(), 'multipart/form-data; boundary=' + boundary


try:
    host.load(manifest, context, module_name='hermes_design_studio_p0_probe', entrypoint=False)
    report['host_pid'] = host.pid
    assert host.pid != os.getpid()
    state = http('GET', '/state')
    assert state['document']['revision'] == 0
    # Run the actual registered handler in the plugin-host process. While it waits,
    # send an actual HTTP response through that SAME host's ASGI bridge.
    output = io.BytesIO()
    Image.new('RGBA', (64, 48), (32, 96, 180, 255)).save(output, format='PNG')
    png = output.getvalue()
    started = time.monotonic()
    with ThreadPoolExecutor(max_workers=1) as pool:
        future = pool.submit(registry.dispatch, 'design_studio_preview', {}, scope=manager.scope_key)
        until = time.monotonic() + 8
        pending = []
        while time.monotonic() < until:
            pending = http('GET', '/render/requests')['requests']
            if pending:
                break
            time.sleep(0.05)
        assert pending, 'handler did not publish a request'
        request = pending[0]
        body, ctype = multipart(png)
        meta = {'revision': 0, 'metrics': {'width': 64, 'height': 48, 'fixture': True}}
        response = http('POST', '/render/response', {'id': request['request_id'], 'meta': json.dumps(meta)}, body, ctype)
        result = future.result(timeout=12)
    assert isinstance(result, dict), result
    assert result.get('_multimodal') is True, result
    assert any(part['type'] == 'image_url' for part in result['content'])
    report['wait_and_multimodal'] = {'pass': True, 'elapsed_seconds': time.monotonic()-started,
        'request_id': request['request_id'], 'text_summary': result['text_summary'],
        'image_present': True, 'same_host_asgi_response': response}
    # Actual valid, uncompressed high-entropy PNG over 20 MiB. Bounded 2400².
    output = io.BytesIO()
    Image.frombytes('RGBA', (2400, 2400), os.urandom(2400*2400*4)).save(output, format='PNG', compress_level=0)
    payload = output.getvalue()
    assert len(payload) >= 20*1024*1024
    sha = hashlib.sha256(payload).hexdigest()
    upload_id = uuid.uuid4().hex
    chunks = [payload[i:i+4*1024*1024] for i in range(0, len(payload), 4*1024*1024)]
    receipts = []
    for index, chunk in enumerate(chunks):
        body, ctype = multipart(chunk)
        receipt = http('POST', '/assets/upload', {'id': upload_id, 'index': index,
            'total': len(chunks), 'sha256': sha}, body, ctype)
        receipts.append(receipt)
    final = receipts[-1]
    # Locate the actual resulting asset by hash, independent of receipt key spelling.
    files = list((HOME / 'plugin-data' / 'hermes-design-studio' / 'assets').glob(sha + '.*'))
    assert len(files) == 1, files
    stored = files[0]
    assert stored.stat().st_size == len(payload)
    assert hashlib.sha256(stored.read_bytes()).hexdigest() == sha
    with Image.open(stored) as image:
        image.verify()
    with Image.open(stored) as image:
        image.load()
        assert image.size == (2400, 2400)
    report['chunk_upload'] = {'pass': True, 'bytes': len(payload), 'chunks': len(chunks),
        'sha256': sha, 'stored_path': str(stored), 'dimensions': [2400,2400], 'receipt': final,
        'transport': 'real PluginHost ASGI multipart; NOT client ctx.rest'}
    report['pass'] = True
except BaseException as exc:
    report['pass'] = False
    report['error'] = f'{type(exc).__name__}: {exc}'
    raise
finally:
    manager.unload()
    host.shutdown()
    path = ROOT / 'evidence' / 'p0-host-integration.json'
    path.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
