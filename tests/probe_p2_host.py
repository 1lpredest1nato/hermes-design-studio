"""Real seven-tool PluginHost + browser GPU probe, isolated from user state.

This exercises registered handlers directly, not an LLM, real Desktop, or human
approval. Nothing approves the draft. All pixels come from actual WebGL renders.
"""
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from typing import Any
import hashlib
import json
import os
import select
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from PIL import Image
from hermes_constants import set_hermes_home_override
from hermes_cli.plugins import PluginManager, PluginContext, parse_manifest_file
from hermes_cli.plugin_host import PluginHost
from tools.registry import registry

HOME = ROOT / 'evidence' / 'p2-host-home' / uuid.uuid4().hex
HOME.mkdir(parents=True)
os.environ['HERMES_HOME'] = str(HOME)
os.environ['HERMES_DISABLE_LAZY_INSTALLS'] = '1'
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
set_hermes_home_override(HOME)
manager = PluginManager(scope_key=str(HOME))
host = PluginHost(manager)
manifest = parse_manifest_file(ROOT / 'plugin.yaml', ROOT, 'user', '')
assert manifest is not None
context = PluginContext(manifest, manager)
report = {'scope': 'actual registered PluginHost handlers + real Chromium WebGL; no LLM/Desktop/human approval',
          'parent_pid': os.getpid(), 'calls': []}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        self.handle_request()

    def do_POST(self):
        self.handle_request()

    def handle_request(self):
        parts = urlparse(self.path)
        try:
            if parts.path.startswith('/api/'):
                body = self.rfile.read(int(self.headers.get('content-length', 0)))
                r = host.asgi_request('hermes-design-studio', str(ROOT / 'dashboard'), 'plugin_api.py',
                                     self.command, parts.path[4:], parts.query,
                                     [['content-type', self.headers.get('content-type', 'application/json')]],
                                     body, timeout=20, authenticated=True)
                self.send_response(r['status'])
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(r['body'])
                return
            if parts.path == '/':
                payload, content_type = b'P2 secondary host/GPU integration', 'text/html'
            else:
                path = (ROOT / parts.path.lstrip('/')).resolve()
                assert path.is_relative_to(ROOT) and path.suffix == '.mjs'
                payload, content_type = path.read_bytes(), 'text/javascript'
            self.send_response(200)
            self.send_header('content-type', content_type)
            self.end_headers()
            self.wfile.write(payload)
        except (OSError, ValueError, AssertionError) as exc:
            self.send_response(500)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(exc)}).encode())


def invoke(name, args, expect_error=False) -> Any:
    raw = registry.dispatch('design_studio_' + name, args, scope=manager.scope_key)
    value = json.loads(raw) if isinstance(raw, str) else raw
    assert isinstance(value, (dict, list)), value
    if expect_error:
        assert isinstance(value, dict) and value.get('error'), value
    elif isinstance(value, dict):
        assert not value.get('error'), value
    compact = {k: v for k, v in value.items() if k != 'content'} if isinstance(value, dict) else value
    if isinstance(value, dict) and value.get('_multimodal'):
        assert isinstance(compact, dict)
        compact['image_present'] = any(x['type'] == 'image_url' for x in value['content'])
        assert compact['image_present']
    report['calls'].append({'tool': 'design_studio_' + name, 'args': args, 'result': compact})
    return value


server = None
browser = None
stderr = (ROOT / 'evidence/p2-host-browser-stderr.txt').open('w')
try:
    host.load(manifest, context, module_name='hermes_design_studio_p2_probe', entrypoint=False)
    report['host_pid'] = host.pid
    assert host.pid != os.getpid()
    skill = manager.find_plugin_skill('hermes-design-studio:usage')
    assert skill and Path(skill).is_file(), 'native bundled skill not registered through real host'
    report['skill'] = str(skill)
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    browser = subprocess.Popen(['node', str(ROOT / 'tests/p2-host-renderer.mjs'),
                                f'http://127.0.0.1:{server.server_port}',
                                str(ROOT / 'evidence/p2-host-browser.json')],
                               cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=stderr, text=True)
    assert browser.stdout is not None
    ready, _, _ = select.select([browser.stdout], [], [], 15)
    assert ready and browser.stdout.readline().strip() == 'ready', 'browser renderer did not start'
    catalog = invoke('catalog', {})
    assert len(catalog['tools']) == 7
    doc = invoke('project', {'action': 'get'})
    source = HOME / 'source.png'
    image = Image.new('RGB', (64, 48))
    image.putdata([(x * 4, y * 5, (x * 3 + y * 7) % 256) for y in range(48) for x in range(64)])
    image.save(source)
    imported = invoke('project', {'action': 'import_image', 'path': str(source)})
    doc = imported['document']
    changed = invoke('apply', {'project_id': doc['id'], 'base_revision': doc['revision'],
                              'commands': [{'type': 'add_node', 'tool': 'builtin/pixelate@1', 'params': {'size': 4}},
                                           {'type': 'add_node', 'tool': 'builtin/levels@1', 'params': {'brightness': 0.1}}]})
    doc = changed['document']
    preview = invoke('preview', {'max_size': 1600})
    assert preview['_multimodal'] and not preview['stale']
    assert preview['revision'] == doc['revision'] and preview['metrics']['difference_source'] > 0
    draft = invoke('create_tool', {'name': 'Host transport inversion',
                                  'description': 'Actual GPU compile in isolated test, not human approval evidence',
                                  'params': [],
                                  'shader': 'void main(){vec4 c=texture(u_input,v_uv);outColor=vec4(1.0-c.rgb,c.a);}'})
    assert draft['compilation'] == 'passed' and draft['_multimodal'] and draft['needs_human_approval']
    denied = invoke('apply', {'project_id': doc['id'], 'base_revision': doc['revision'],
                             'commands': [{'type': 'add_node', 'tool': draft['ref']}]}, expect_error=True)
    saved = invoke('recipe', {'action': 'save', 'name': 'Host transport recipe'})
    recipes = invoke('recipe', {'action': 'list'})
    assert saved['id']
    applied = invoke('recipe', {'action': 'apply', 'id': saved['id'],
                                'project_id': doc['id'], 'base_revision': doc['revision']})
    doc = applied['document']
    exported = invoke('export', {'format': 'png'})
    path = Path(exported['path'])
    assert path.parent == HOME / 'plugin-data/hermes-design-studio/exports'
    assert hashlib.sha256(path.read_bytes()).hexdigest() == exported['sha256']
    with Image.open(path) as im:
        im.verify()
    with Image.open(path) as im:
        im.load()
        assert im.size == (64, 48)
    rows = [json.loads(line) for line in (HOME / 'plugin-data/hermes-design-studio/commands.jsonl').read_text().splitlines()]
    assert len(rows) == 3 and all(row['source'] == 'agent' for row in rows)
    assert [row['id'] for row in rows] == [imported['command_id'], changed['command_id'], applied['command_id']]
    report['commands'] = [{'id': row['id'], 'project_id': row['project_id'],
                           'base_revision': row['base_revision'], 'revision': row['revision']} for row in rows]
    report['export_verified'] = {'path': str(path), 'sha256': exported['sha256'], 'dimensions': [64, 48]}
    report['draft_remains_unapproved'] = not (HOME / 'plugin-data/hermes-design-studio/tools/host-transport-inversion').exists()
    assert report['draft_remains_unapproved']
    report['pass'] = True
except BaseException as exc:
    report['pass'] = False
    report['error'] = f'{type(exc).__name__}: {exc}'
    raise
finally:
    if browser is not None:
        if browser.poll() is None and browser.stdin is not None:
            browser.stdin.write('stop\n')
            browser.stdin.flush()
            browser.stdin.close()
            try:
                browser.wait(timeout=20)
            except subprocess.TimeoutExpired:
                browser.kill()
                browser.wait()
        report['browser_exit'] = browser.returncode
        if browser.returncode:
            report['pass'] = False
    if server is not None:
        server.shutdown()
        server.server_close()
    manager.unload()
    host.shutdown()
    stderr.close()
    (ROOT / 'evidence/p2-host-integration.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))
    if not report.get('pass'):
        sys.exit(1)
