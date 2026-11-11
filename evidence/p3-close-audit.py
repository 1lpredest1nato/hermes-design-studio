"""Focused P3 checks; no renderer/project commands, provisioning or config writes."""
from pathlib import Path
import datetime
import hashlib
import importlib.util
import json
import os
import re
import subprocess
import sys
import urllib.request
import yaml

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence'
ENV = {**os.environ, 'HERMES_HOME': '/home/destino/.hermes',
       'HERMES_DISABLE_LAZY_INSTALLS': '1', 'PYTHONDONTWRITEBYTECODE': '1',
       'PYTEST_DISABLE_PLUGIN_AUTOLOAD': '1', 'GIT_OPTIONAL_LOCKS': '0'}
readme = (ROOT / 'README.md').read_text()
submission = (ROOT / 'SUBMISSION.md').read_text()
manifest = yaml.safe_load((ROOT / 'plugin.yaml').read_text())
catalog = yaml.safe_load((ROOT / 'plugin-catalog/hermes-design-studio.yaml').read_text())
post_match = re.search(r'## Draft X post.*?```text\n(.*?)\n```', submission, re.S)
assert post_match is not None, 'Submission X draft text block must exist'
post = post_match.group(1)
intervals = []
for a, b, seconds in re.findall(r'\| (\d\d:\d\d)–(\d\d:\d\d) \| (\d+) s \|', submission):
    value = lambda t: sum(int(n) * m for n, m in zip(t.split(':'), (60, 1)))
    intervals.append({'from': a, 'to': b, 'start': value(a), 'end': value(b), 'declared_seconds': int(seconds)})
links = []
for relative in ('README.md', 'SUBMISSION.md', 'docs/architecture-and-verification.md'):
    for label, href in re.findall(r'!?\[([^\]]*)\]\(([^)]+)\)', (ROOT / relative).read_text()):
        if not href.startswith(('http:', 'https:', '#')):
            target = ROOT / Path(relative).parent / href.split('#')[0]
            links.append({'document': relative, 'label': label, 'href': href, 'exists': target.exists()})
records = {}
for phase in ('p0', 'p1', 'p2'):
    path = OUT / f'{phase}-runtime-verification.json'
    data = json.loads(path.read_text())
    record = {'path': str(path.relative_to(ROOT)), 'bytes': path.stat().st_size,
              'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'recorded_pass': data['pass'],
              'scope': data['scope'], 'live_verifier_rerun': False}
    if phase == 'p0':
        record.update(session=data['session']['id'], request_id=data['request']['request_id'],
                      detached_closed_page=data['render']['detached_canvas'] and data['render']['page_active'] is False,
                      upload_bytes=data['upload']['actual_png_bytes'], upload_hash_match=data['upload']['sha256_match'],
                      save_as=data['save_as'], recorded_pngs=data['files'])
    elif phase == 'p1':
        checks = data['checks']
        record.update(gates={k: v['pass'] for k, v in checks.items()},
                      diagnostics_tools=[x['tool'] for x in checks['diagnostics']['evidence']['checks']],
                      diagnostics_cases=sum(len(x['cases']) for x in checks['diagnostics']['evidence']['checks']),
                      project_id=checks['manual_project']['evidence']['project_id'],
                      ui_commands=len(checks['manual_project']['evidence']['ui_command_ids']),
                      exports=checks['exports']['evidence'])
    else:
        record.update(session=data['session']['id'], approval_message_id=data['approval_message']['id'],
                      commands=[{k: row[k] for k in ('id', 'project_id', 'source', 'base_revision', 'revision')} for row in data['agent_commands']],
                      approved_tool=data['approved_manifest']['id'], approved_provenance=data['approved_manifest']['provenance'],
                      source_shader_matches_checked_request=data['created']['arguments']['shader'] == data['frames'][1]['request']['entry']['shader'],
                      approved_manifest_matches_checked_request=data['approved_manifest'] == data['frames'][1]['request']['entry']['manifest'],
                      frames=[{'tool': row['tool']['name'], 'request_id': row['request']['request_id'],
                               'revision': row['request']['document']['revision'],
                               'command_id': row['request']['document'].get('last_command_id'),
                               'closed_page': row['response']['page_active'] is False,
                               'detached': row['response']['detached_canvas'],
                               'sha256': row['response']['sha256'], 'dimensions': row['dimensions'],
                               'recorded_pillow_pass': row['pillow_verify_load']} for row in data['frames']])
    records[phase] = record

# Use existing test packages only, matching the project's runner discovery.
extras = []
for name in ('pytest', 'pluggy', 'iniconfig', 'packaging', 'pygments'):
    if importlib.util.find_spec(name) is None:
        candidates = sorted((Path.home() / '.hermes/cache/uv/archive-v0').glob('*/' + name))
        if candidates:
            extras.append(str(candidates[0].parent))
ENV['PYTHONPATH'] = os.pathsep.join(filter(None, [str(ROOT), *extras, ENV.get('PYTHONPATH')]))
command = [sys.executable, '-m', 'pytest', '-q', '-p', 'no:cacheprovider', 'tests/test_usage_skill.py', 'tests/test_install.py']
tests = subprocess.run(command, cwd=ROOT, env=ENV, capture_output=True, timeout=90)
(OUT / 'p3-close-focused-tests.stdout.txt').write_bytes(tests.stdout)
(OUT / 'p3-close-focused-tests.stderr.txt').write_bytes(tests.stderr)
(OUT / 'p3-close-focused-tests.json').write_text(json.dumps({'command': command, 'exit_code': tests.returncode,
    'environment': 'child-only overrides; existing pure-Python cache, no installs', 'full_suite_rerun': False}, indent=2) + '\n')
urls = ['https://raw.githubusercontent.com/NousResearch/hermes-agent/main/plugin-catalog/README.md',
        'https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk/',
        'https://hermes-agent.nousresearch.com/docs/developer-guide/plugins/']
remote = []
for index, url in enumerate(urls):
    try:
        with urllib.request.urlopen(url, timeout=20) as response:
            payload = response.read()
            row = {'url': url, 'status': response.status, 'final_url': response.url,
                   'sha256': hashlib.sha256(payload).hexdigest()}
            if index == 0:
                (OUT / 'p3-close-catalog-schema-source.md').write_bytes(payload)
                schema_text = payload.decode()
                row['saved'] = 'evidence/p3-close-catalog-schema-source.md'
                row['mandatory_sha_rule_found'] = 'sha: <40-hex commit sha>' in schema_text
            remote.append(row)
    except Exception as exc:
        remote.append({'url': url, 'error': type(exc).__name__ + ': ' + str(exc)})

baseline = 'f3aef873e24173a28677c8f28606175762e60b55'
source = '610f92e7c8e1a697b909de22c357856b0ed191fc'
changed = subprocess.run(['git', 'diff', '--name-only', baseline + '..' + source], cwd=ROOT, env=ENV,
                         capture_output=True, check=True, text=True).stdout.splitlines()
executable_changes = [p for p in changed if p == '__init__.py' or p.startswith(('studio_core/', 'core/', 'hermes/', 'desktop/', 'dashboard/', 'tools/'))]
suite = (OUT / 'p2-parent-suite.txt').read_text()
result = {'checked_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'source_commit': source, 'code_baseline': baseline, 'changed_since_baseline': changed,
          'executable_changes_since_baseline': executable_changes,
          'prior_full_suite_record': {'python_summary': re.findall(r'\d+ passed, \d+ warnings in [\d.]+s', suite),
                                      'node_pass': re.findall(r'ℹ pass (\d+)', suite), 'node_fail': re.findall(r'ℹ fail (\d+)', suite)},
          'manifest': manifest,
          'catalog': {'parsed': catalog, 'tools_match_manifest': catalog['capabilities']['provides_tools'] == manifest['provides_tools'],
                      'requires_matches': catalog['requires_hermes'] == manifest['requires_hermes'],
                      'version_matches': catalog['version'] == manifest['version'],
                      'sha_present': 'sha' in catalog, 'admission_ready': False,
                      'reason': 'Explicit unpublished draft, intentionally missing mandatory exact SHA; public repo not verified.'},
          'submission': {'post_text': post, 'post_unicode_length': len(post), 'post_within_280': len(post) <= 280,
                         'mentions_nous': '@NousResearch' in post, 'video_intervals': intervals,
                         'script_seconds': sum(x['declared_seconds'] for x in intervals),
                         'interval_durations_match': all(x['end'] - x['start'] == x['declared_seconds'] for x in intervals),
                         'intervals_continuous': all(a['end'] == b['start'] for a, b in zip(intervals, intervals[1:])),
                         'actual_video_measured': False, 'publication_performed': False},
          'local_markdown_links': links, 'broken_markdown_links': [x for x in links if not x['exists']],
          'literal_delivery_evidence_ref': {'path': 'evidence/p3-final-install.json',
                                           'exists_in_worktree': (OUT / 'p3-final-install.json').exists(),
                                           'parent_path_exists': Path('/home/destino/projects/hermes-design-studio/evidence/p3-final-install.json').exists()},
          'remote_reference_reads': remote, 'prior_acceptance_records': records,
          'focused_tests_exit_code': tests.returncode,
          'limits': ['Prior runtime evidence records inspected in full; live user projects, histories and PNGs not re-exercised.',
                     'No new isolated runtime bootstrap attempted; prior temp-home validate timeout remains in the parent evidence.',
                     'Catalog schema checked against canonical documented entry schema, not claimed accepted or published.']}
(OUT / 'p3-close-audit.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({k: result[k] for k in ('executable_changes_since_baseline', 'prior_full_suite_record', 'focused_tests_exit_code', 'submission', 'broken_markdown_links', 'literal_delivery_evidence_ref', 'remote_reference_reads')}, ensure_ascii=False, indent=2))
print(tests.stdout.decode(errors='replace'))
print(tests.stderr.decode(errors='replace'))
raise SystemExit(tests.returncode)
