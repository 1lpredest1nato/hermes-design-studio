"""Run tests without installing anything into Hermes' managed environment.

Uses normal pytest when available. TEST_EXTRA_PYTHONPATH may name an existing
pytest environment/cache; this changes only this child process's import path.
"""
from pathlib import Path
import os
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
if __name__ == '__main__':
    env = os.environ.copy()
    env['PYTHONDONTWRITEBYTECODE'] = '1'
    env['HERMES_DISABLE_LAZY_INSTALLS'] = '1'
    env['PYTEST_DISABLE_PLUGIN_AUTOLOAD'] = '1'
    if '--python-only' in sys.argv:
        sys.argv.remove('--python-only')
        python_only = True
    else:
        python_only = False
    extras = env.get('TEST_EXTRA_PYTHONPATH', '')
    if not extras:
        # Read an existing pure-Python test cache; never provision dependencies.
        cache = Path.home() / '.hermes/cache/uv/archive-v0'
        modules = ('pytest', 'pluggy', 'iniconfig', 'packaging', 'pygments')
        found = []
        for module in modules:
            candidates = sorted(cache.glob('*/' + module))
            if candidates:
                found.append(str(candidates[0].parent))
        extras = os.pathsep.join(found)
    env['PYTHONPATH'] = os.pathsep.join(filter(None, [str(ROOT), extras, env.get('PYTHONPATH')]))
    command = [sys.executable, '-m', 'pytest', '-q', 'tests', *sys.argv[1:]]
    result = subprocess.run(command, cwd=ROOT, env=env)
    if result.returncode:
        raise SystemExit(result.returncode)
    if python_only:
        raise SystemExit(0)
    js_tests = sorted(str(p.relative_to(ROOT)) for p in (ROOT / 'tests').glob('*.test.mjs'))
    if js_tests:
        raise SystemExit(subprocess.run(['node', '--test', *js_tests], cwd=ROOT, env=env).returncode)
