"""Copy a development package, never touch configuration or other plugins."""
from pathlib import Path
import hashlib
import json
import os
import shutil

ROOT = Path(__file__).resolve().parents[1]
TOP_FILES = ('plugin.yaml', '__init__.py', 'README.md', 'LICENSE', 'package.json')
FOLDERS = ('studio_core', 'core', 'hermes', 'desktop', 'dashboard', 'tools', 'skills')


def install(source: Path, target: Path) -> dict:
    source, target = Path(source), Path(target)
    if target.name != 'hermes-design-studio':
        raise ValueError('Only the hermes-design-studio package may be written')
    for path in (target, *target.parents):
        if path.is_symlink():
            raise ValueError(f'Refusing symlink install directory: {path}')
    files = [source / name for name in TOP_FILES if (source / name).exists() or (source / name).is_symlink()]
    for name in FOLDERS:
        directory = source / name
        if directory.is_symlink():
            raise ValueError(f'Refusing symlink source: {directory}')
        if directory.exists():
            files.extend(p for p in directory.rglob('*') if p.is_file() or p.is_symlink())
    files = [p for p in files if '__pycache__' not in p.parts and p.suffix != '.pyc']
    for path in files:
        if path.is_symlink():
            raise ValueError(f'Refusing symlink payload: {path}')
        destination = target / path.relative_to(source)
        if any(p.is_symlink() for p in (destination, *destination.parents)):
            raise ValueError(f'Refusing symlink destination: {destination}')
    hashes = {}
    for path in sorted(files):
        relative = path.relative_to(source)
        destination = target / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        expected = hashlib.sha256(path.read_bytes()).hexdigest()
        actual = hashlib.sha256(destination.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f'Copy hash mismatch: {relative}')
        hashes[str(relative)] = {'sha256': actual, 'bytes': destination.stat().st_size}
    return {'source': str(source), 'target': str(target), 'copy_verified': True, 'files': hashes}


if __name__ == '__main__':
    home = Path(os.environ.get('HERMES_HOME', str(Path.home() / '.hermes'))).expanduser()
    if home.resolve() != (Path.home() / '.hermes').resolve():
        raise SystemExit('Development install authorized only for the default profile')
    result = install(ROOT, home / 'plugins' / 'hermes-design-studio')
    output = ROOT / 'evidence' / 'install.json'
    output.parent.mkdir(exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps({'copy_verified': True, 'files': len(result['files']), 'target': result['target']}))
