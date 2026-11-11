"""Read-only real P2 session audit. No tool dispatch or human-action simulation."""
from pathlib import Path
import hashlib
import json
import sqlite3
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = Path.home() / '.hermes/plugin-data/hermes-design-studio'
SID = '20261111_222455_71cfd9'
con = sqlite3.connect((Path.home() / '.hermes/state.db').as_uri() + '?mode=ro', uri=True)
con.row_factory = sqlite3.Row
session = dict(con.execute('SELECT id,model,started_at,parent_session_id FROM sessions WHERE id=?', (SID,)).fetchone())
rows = [dict(r) for r in con.execute('SELECT id,role,content,tool_calls,tool_name,tool_call_id,timestamp FROM messages WHERE session_id=? ORDER BY id', (SID,))]
by_id = {r['id']: r for r in rows}
calls = {}
for row in rows:
    for call in json.loads(row['tool_calls'] or '[]'):
        calls[call['id']] = (row, call)


def result(mid):
    row = by_id[mid]
    parent, call = calls[row['tool_call_id']]
    assert session['started_at'] <= parent['timestamp'] <= row['timestamp']
    function = call['function']
    args = json.loads(function['arguments'])
    if function['name'] == 'tool_call':
        matches = [c for c in args['calls'] if c['name'] == row['tool_name']]
        assert len(matches) == 1
        args = matches[0]['arguments']
    else:
        assert function['name'] == row['tool_name']
    payload = json.loads(row['content'].split('\n', 1)[0])
    return {'message_id': mid, 'call_message_id': parent['id'], 'call_id': call['id'],
            'name': row['tool_name'], 'arguments': args, 'result': payload,
            'timestamp': row['timestamp']}


baseline = json.loads((ROOT / 'evidence/p2-live-baseline.json').read_text())
ledger = [json.loads(line) for line in (DATA / 'commands.jsonl').read_text().splitlines()]
new = [r for r in ledger if r['id'] not in set(baseline['command_ids'])]
first, applied = result(7083), result(7111)
assert [r['id'] for r in new] == [first['result']['command_id'], applied['result']['command_id']]
for record, tool in zip(new, (first, applied)):
    assert record['source'] == 'agent'
    assert record['project_id'] == tool['arguments']['project_id']
    assert record['base_revision'] == tool['arguments']['base_revision']
    assert record['commands'] == tool['arguments']['commands']
    assert record['document'] == tool['result']['document']
assert [r['revision'] for r in new] == [29, 30]
assert new[0]['base_revision'] == baseline['project']['revision'] == 28
created = result(7087)
assert created['result']['compilation'] == 'passed' and created['result']['needs_human_approval'] is True
rid = created['result']['request_id']
request = json.loads((DATA / 'requests' / (rid + '.json')).read_text())
assert request['entry']['shader'] == created['arguments']['shader']
assert request['entry']['manifest']['provenance']['author'] == 'agent'
manifest = json.loads((DATA / 'tools/duotone-ink-screen/1/manifest.json').read_text())
assert manifest == request['entry']['manifest'], 'human-approved manifest differs from agent snapshot'
shader = (DATA / 'tools/duotone-ink-screen/1/shader.frag').read_text()
assert shader == created['arguments']['shader']
assert not (DATA / 'drafts/duotone-ink-screen/entry.json').exists()
approval = by_id[7091]
assert approval['role'] == 'user' and approval['content'].startswith('Одобрил.')
assert created['timestamp'] < approval['timestamp'] < applied['timestamp']
approved_catalog = result(7095)['result']
assert any(t['ref'] == 'user/duotone-ink-screen@1' for t in approved_catalog['tools'])
assert any(c['type'] == 'add_node' and c['tool'] == 'user/duotone-ink-screen@1' for c in new[-1]['commands'])
recipe = result(7077)
assert recipe['result']['id'] and (DATA / 'recipes' / (recipe['result']['id'].split('/')[-1] + '.json')).exists()
report = json.loads((DATA / 'p0-report.json').read_text())
frames = []
for mid in (7085, 7087, 7113, 7116):
    tool = result(mid)
    frame = tool['result']
    req = json.loads((DATA / 'requests' / (frame['request_id'] + '.json')).read_text())
    receipt = json.loads((DATA / 'responses' / (frame['request_id'] + '.json')).read_text())
    render = report['renders'][frame['request_id']]
    assert frame['sha256'] == receipt['sha256'] == render['receipt']['sha256']
    assert frame['revision'] == receipt['revision'] == req['document']['revision']
    assert frame['build'] == 'design-studio-p2-20261111-agent-1'
    assert frame['page_active'] is False and frame['detached_canvas'] is True
    assert frame['metrics']['dominant_colors'] and 'difference_source' in frame['metrics']
    if mid in (7085, 7113):
        assert frame['stale'] is False
    if mid in (7113, 7116):
        assert req['document']['last_command_id'] == new[-1]['id']
    path = Path(frame['path'])
    assert path.resolve().is_relative_to(DATA.resolve())
    assert hashlib.sha256(path.read_bytes()).hexdigest() == frame['sha256']
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        image.load()
        size = list(image.size)
    if mid == 7116:
        assert path.parent == DATA / 'exports' and size == [1536, 1024]
    frames.append({'tool': tool, 'request': req, 'response': receipt, 'render': render,
                   'pillow_verify_load': True, 'dimensions': size})
failed = result(7101)
assert failed['result']['status'] == 400
assert len(new) == 2, 'rejected batch must not create a command'
assert any(r['tool_name'] == 'skill_view' and 'hermes-design-studio' in r['content'] for r in rows)
# Include only relevant original messages; no request dumps or credential state.
evidence = {'pass': True, 'scope': 'real fresh LLM session + human approval + connected client Desktop, read-only audit',
            'session': session, 'approval_message': approval, 'agent_commands': new,
            'created': created, 'approved_manifest': manifest, 'recipe': recipe,
            'frames': frames, 'rejected_batch': failed,
            'note': 'An add_node batch with unsupported enabled/opacity/blend fields was rejected atomically; agent read schema and corrected it. Later installed-skill documentation edit is not part of tool implementation proof.'}
(ROOT / 'evidence/p2-runtime-verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'pass': True, 'session': SID, 'commands': [r['id'] for r in new],
                  'revisions': [r['revision'] for r in new], 'draft': manifest['id'],
                  'export': frames[-1]['response'], 'files_pillow_verified': len(frames)}, indent=2))
