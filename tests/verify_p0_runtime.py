"""Read-only verification of the actual client Desktop and fresh-session proof."""
from pathlib import Path
import hashlib
import json
import sqlite3
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = Path.home() / '.hermes/plugin-data/hermes-design-studio'
SID = '20261111_191301_ea4a4b'
report = json.loads((DATA / 'p0-report.json').read_text())
con = sqlite3.connect((Path.home() / '.hermes/state.db').as_uri() + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
session = dict(con.execute('SELECT id,model,started_at,parent_session_id FROM sessions WHERE id=?', (SID,)).fetchone())
rows = [dict(row) for row in con.execute('SELECT id,role,content,tool_calls,tool_name,tool_call_id,timestamp FROM messages WHERE session_id=? ORDER BY id', (SID,))]
call = next(r for r in rows if r['id'] == 5072)
result = next(r for r in rows if r['id'] == 5073)
call_record = json.loads(call['tool_calls'])[0]
assert call_record['function']['name'] == 'tool_call'
assert 'design_studio_preview' in call_record['function']['arguments']
assert call_record['id'] == result['tool_call_id']
assert result['tool_name'] == 'design_studio_preview'
assert session['started_at'] <= call['timestamp'] < result['timestamp']
summary = json.loads(result['content'].split('\n', 1)[0])
rid = summary['request_id']
request = json.loads((DATA / 'requests' / (rid + '.json')).read_text())
response = json.loads((DATA / 'responses' / (rid + '.json')).read_text())
render = report['renders'][rid]
assert request['request_id'] == response['request_id'] == render['request_id'] == rid
assert summary['run_id'] == render['run_id'] == report['run_id']
assert render['page_active'] is False and render['detached_canvas'] is True
assert summary['stale'] is False and summary['revision'] == request['document']['revision']
assert summary['path'] == response['path'] == render['receipt']['path']
assert report['save_as']['dialog_verified'] is True
assert report['save_as']['evidence'] == 'explicit-user-confirmation'
upload = report['upload_probe']
assert upload['status'] == 'complete' and upload['sha256_match'] is True
assert upload['actual_png_bytes'] >= 20 * 1024 * 1024
verified_files = []
for path, sha, size in [(Path(summary['path']), summary['sha256'], None),
                         (Path(upload['receipt']['path']), upload['sha256'], upload['actual_png_bytes'])]:
    raw = path.read_bytes()
    assert hashlib.sha256(raw).hexdigest() == sha
    if size is not None:
        assert len(raw) == size
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        image.load()
        dimensions = list(image.size)
    verified_files.append({'path': str(path), 'sha256': sha, 'bytes': len(raw), 'dimensions': dimensions, 'pillow_verify_and_load': True})
metrics_required = ['mean_luma', 'std_luma', 'shadow_clipping_pct', 'highlight_clipping_pct', 'dominant_colors', 'detail_density', 'nearly_uniform']
assert all(key in summary['metrics'] for key in metrics_required)
evidence = {'pass': True, 'scope': 'actual client Desktop + fresh agent session, independently correlated',
    'session': session, 'messages': [r for r in rows if r['id'] in (5069,5072,5073,5074)],
    'request': request, 'render': render, 'preview_summary': summary,
    'upload': upload, 'save_as': report['save_as'], 'files': verified_files}
(ROOT / 'evidence/p0-runtime-verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
(ROOT / 'evidence/p0-client-report.json').write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({'pass': True, 'session_id': SID, 'request_id': rid, 'page_active': False,
    'upload_bytes': upload['actual_png_bytes'], 'files': verified_files}, indent=2))
