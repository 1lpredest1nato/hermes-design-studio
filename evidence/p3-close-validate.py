"""Read-only exact-clone verification; writes evidence only in this worktree."""
from pathlib import Path
import datetime
import hashlib
import json
import os
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
EXPECTED = '610f92e7c8e1a697b909de22c357856b0ed191fc'
HOME = Path('/home/destino/projects/hermes-design-studio/evidence/tmp-p3-final-home')
TARGET = HOME / 'plugins/hermes-design-studio'
OUT = ROOT / 'evidence'
ENV = {**os.environ, 'HERMES_HOME': '/home/destino/.hermes',
       'HERMES_DISABLE_LAZY_INSTALLS': '1', 'PYTHONDONTWRITEBYTECODE': '1',
       'GIT_OPTIONAL_LOCKS': '0'}


def git(*args, cwd=ROOT):
    return subprocess.run(['git', *args], cwd=cwd, env=ENV,
                          capture_output=True, check=True).stdout


def snapshot(root):
    """No content or credential reads: names, file sizes and mtimes only."""
    items = {}
    for directory, dirs, files in os.walk(root, followlinks=False):
        for name in dirs + files:
            path = Path(directory) / name
            stat = path.lstat()
            items[str(path.relative_to(root))] = [stat.st_mode, stat.st_size, stat.st_mtime_ns]
    return items


assert git('rev-parse', 'HEAD').decode().strip() == EXPECTED
assert git('branch', '--show-current').decode().strip() == 'verify/p3-close'
before = snapshot(HOME)
metadata_path = TARGET.parent / '.install-metadata.json'
metadata = json.loads(metadata_path.read_text())['hermes-design-studio']
assert metadata['revision'] == EXPECTED and metadata['pinned'] is True
clone_head = git('rev-parse', 'HEAD', cwd=TARGET).decode().strip()
assert clone_head == EXPECTED
tracked = git('ls-tree', '-r', '--name-only', EXPECTED).decode().splitlines()
folders = ('studio_core/', 'core/', 'hermes/', 'desktop/', 'dashboard/', 'tools/', 'skills/')
files = sorted(p for p in tracked if p in ('plugin.yaml', '__init__.py', 'README.md', 'LICENSE', 'package.json') or p.startswith(folders))
rows = []
for relative in files:
    expected = git('show', f'{EXPECTED}:{relative}')
    installed = (TARGET / relative).read_bytes()
    rows.append({'path': relative, 'bytes': len(installed),
                 'source_sha256': hashlib.sha256(expected).hexdigest(),
                 'installed_sha256': hashlib.sha256(installed).hexdigest(),
                 'match': expected == installed})
readback = {'source_commit': EXPECTED, 'target': str(TARGET), 'clone_head': clone_head,
            'install_metadata': metadata, 'payload_count': len(rows),
            'optional_package_json_exists': 'package.json' in tracked,
            'payload_files': rows, 'mismatches': [r['path'] for r in rows if not r['match']],
            'installed_manifest': (TARGET / 'plugin.yaml').read_text(),
            'installed_skill_exists': (TARGET / 'skills/usage/SKILL.md').is_file()}
(OUT / 'p3-close-payload-readback.json').write_text(json.dumps(readback, indent=2) + '\n')
command = [sys.executable, '-m', 'hermes_cli.main', 'plugins', 'validate', str(TARGET)]
started = datetime.datetime.now(datetime.timezone.utc).isoformat()
start = time.monotonic()
try:
    result = subprocess.run(command, cwd=ROOT, env=ENV, capture_output=True, timeout=150)
    stdout, stderr, code, timed_out = result.stdout, result.stderr, result.returncode, False
except subprocess.TimeoutExpired as exc:
    stdout, stderr, code, timed_out = exc.stdout or b'', exc.stderr or b'', None, True
(OUT / 'p3-close-validate.stdout.txt').write_bytes(stdout)
(OUT / 'p3-close-validate.stderr.txt').write_bytes(stderr)
after = snapshot(HOME)
changed = [p for p in sorted(set(before) | set(after)) if before.get(p) != after.get(p)]
record = {'command': command, 'cwd': str(ROOT), 'started_utc': started,
          'elapsed_seconds': time.monotonic() - start,
          'environment_overrides': {k: ENV[k] for k in ('HERMES_HOME', 'HERMES_DISABLE_LAZY_INSTALLS', 'PYTHONDONTWRITEBYTECODE', 'GIT_OPTIONAL_LOCKS')},
          'exit_code': code, 'timed_out': timed_out,
          'validation_passed_text': b'Validation passed' in stdout,
          'stdout': 'evidence/p3-close-validate.stdout.txt',
          'stderr': 'evidence/p3-close-validate.stderr.txt',
          'isolated_home_entries_before': len(before), 'isolated_home_entries_after': len(after),
          'isolated_home_metadata_unchanged': not changed, 'changed_isolated_home_paths': changed,
          'snapshot_scope': 'All isolated-home path modes/sizes/mtime_ns, no access-time comparison; payload SHA-256 checked separately.',
          'validation_scope': 'Exact existing isolated installed clone, using default working Hermes runtime. This is not a new temp-HERMES_HOME bootstrap or an isolated-runtime validation.'}
(OUT / 'p3-close-validate.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'payload_count': len(rows), 'mismatches': readback['mismatches'], **record}, indent=2))
print('--- stdout ---\n' + stdout.decode(errors='replace'))
print('--- stderr ---\n' + stderr.decode(errors='replace'))
raise SystemExit(0 if code == 0 and not timed_out and not changed and not readback['mismatches'] else 1)
