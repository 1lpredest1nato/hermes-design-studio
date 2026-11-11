"""Filesystem render transport. No Hermes imports or process-local state."""
import contextlib
import fcntl
import hashlib
import json
import struct
import os
from pathlib import Path
import time
import uuid

DEFAULT_DOCUMENT = dict(format=1, id='p0', revision=0, source=None, stack=[], seed=1234, timeline=None)

class Store:
    def __init__(self, root, document_provider=None):
        self.root = Path(root).absolute()
        self.document_provider = document_provider
        if any(p.is_symlink() for p in (self.root, *self.root.parents)):
            raise ValueError('symlink root is forbidden')
        self.root.mkdir(parents=True, exist_ok=True)
        for directory in ('requests', 'responses', 'previews', 'exports', 'assets', 'uploads'):
            self._safe(self.root / directory).mkdir(exist_ok=True)

    def _safe(self, path):
        path = Path(path).absolute()
        if '..' in path.parts or not path.is_relative_to(self.root):
            raise ValueError('path escapes data root')
        for p in (path, *path.parents):
            if p.is_symlink():
                raise ValueError('symlink is forbidden')
            if p == self.root:
                break
        return path

    @staticmethod
    def _id(value):
        import re
        if not isinstance(value, str) or not re.fullmatch(r'[a-f0-9]{32}', value):
            raise ValueError('invalid request id')
        return value

    def _write(self, path, value):
        path = self._safe(path)
        data = json.dumps(value, allow_nan=False).encode()
        if len(data) > 2*1024*1024:
            raise ValueError('JSON too large')
        temporary = path.with_name('.' + uuid.uuid4().hex)
        with temporary.open('xb') as output:
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)

    def _bytes(self, path, limit):
        path = self._safe(path)
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
            data = handle.read(limit + 1)
        if len(data) > limit:
            raise ValueError('file too large')
        return data

    def _read(self, path, default=None):
        try:
            return json.loads(self._bytes(path, 2*1024*1024))
        except FileNotFoundError:
            return default

    def state(self):
        document = (self.document_provider() if self.document_provider is not None
                    else self._read(self.root / 'document.json', DEFAULT_DOCUMENT.copy()))
        pending = [self._read(p) for p in sorted((self.root / 'requests').glob('*.json'))
                   if not (self.root / 'responses' / p.name).exists()]
        return dict(document=document, pending=pending, latest=self._read(self.root / 'latest.json'))

    def request(self, kind, **payload):
        if kind not in ('preview', 'export', 'check'):
            raise ValueError('unknown render kind')
        request = {**payload, 'kind': kind, 'document': self.state()['document'],
                   'created_at': time.time(), 'request_id': uuid.uuid4().hex}
        self._write(self.root / 'requests' / (request['request_id'] + '.json'), request)
        return request

    @contextlib.contextmanager
    def _lock(self):
        path = self._safe(self.root / '.lock')
        with os.fdopen(os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'a+b') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def respond(self, request_id, png, meta):
        self._id(request_id)
        with self._lock():
            target = self.root / 'responses' / (request_id + '.json')
            existing = self._read(target)
            if existing is not None:
                return existing
            request = self._read(self.root / 'requests' / (request_id + '.json'))
            if request is None:
                raise ValueError('unknown request')
            meta = {**meta, 'project_id': request['document']['id']}
            result = self._save_png(png, meta, request['document']['revision'],
                                    'exports' if request['kind'] == 'export' else 'previews')
            result['request_id'] = request_id
            self._write(target, result)
            if request['kind'] == 'preview':
                previous = self._read(self.root / 'latest.json')
                current = self.state()['document']
                if result['project_id'] == current['id'] and (previous is None or
                        previous.get('project_id') != current['id'] or previous['revision'] <= result['revision']):
                    self._write(self.root / 'latest.json', result)
            return result

    def fail(self, request_id, error, meta=None):
        self._id(request_id)
        if not isinstance(error, str) or not error or len(error) > 32768:
            raise ValueError('invalid renderer error')
        with self._lock():
            target = self.root / 'responses' / (request_id + '.json')
            existing = self._read(target)
            if existing is not None:
                return existing
            request = self._read(self.root / 'requests' / (request_id + '.json'))
            if request is None:
                raise ValueError('unknown request')
            result = {**(meta or {}), 'error': error, 'request_id': request_id,
                      'revision': request['document']['revision'], 'created_at': time.time()}
            self._write(target, result)
            return result

    def _save_png(self, png, meta, revision, directory):
        if type(revision) is not int or revision < 0:
            raise ValueError('invalid revision')
        if not isinstance(meta, dict) or len(json.dumps(meta, allow_nan=False).encode()) > 256*1024:
            raise ValueError('invalid metadata or too large')
        if len(png) > 64*1024*1024:
            raise ValueError('PNG too large')
        if len(png) < 24 or png[:8] != b'\x89PNG\r\n\x1a\n' or png[12:16] != b'IHDR':
            raise ValueError('invalid PNG header')
        width, height = struct.unpack('>II', png[16:24])
        if not 0 < width <= 16384 or not 0 < height <= 16384:
            raise ValueError('invalid PNG dimensions')
        digest = hashlib.sha256(png).hexdigest()
        path = self._safe(self.root / directory / (digest + '.png'))
        temporary = path.with_name('.' + uuid.uuid4().hex)
        temporary.write_bytes(png)
        os.replace(temporary, path)
        return {**meta, 'path': str(path), 'sha256': digest, 'width': width,
                'height': height, 'revision': revision, 'created_at': time.time()}

    def cache_preview(self, png, revision, meta):
        with self._lock():
            current = self.state()['document']
            meta = {**meta, 'project_id': meta.get('project_id', current['id'])}
            result = self._save_png(png, meta, revision, 'previews')
            previous = self._read(self.root / 'latest.json')
            if result['project_id'] == current['id'] and (previous is None or
                    previous.get('project_id') != current['id'] or previous['revision'] <= revision):
                self._write(self.root / 'latest.json', result)
            return result

    def preview(self, timeout=10, **payload):
        request = self.request('preview', **payload)
        response = self.wait(request['request_id'], timeout)
        response = response or self._read(self.root / 'latest.json')
        if response is None:
            raise TimeoutError('No renderer response or cached preview. Open Hermes Desktop with the plugin enabled.')
        if response.get('error'):
            raise ValueError(response['error'])
        return {**response, 'request_id': request['request_id'],
                'requested_revision': request['document']['revision'],
                'requested_project_id': request['document']['id'],
                'stale': (response['revision'] != request['document']['revision'] or
                          response.get('project_id') != request['document']['id'])}

    def upload_chunk(self, id, index, total, sha256, data):
        import re
        if not isinstance(id, str) or not re.fullmatch(r'[a-f0-9]{1,64}', id):
            raise ValueError('invalid upload id')
        if not re.fullmatch(r'[a-f0-9]{64}', sha256):
            raise ValueError('invalid full sha256')
        if type(index) is not int or type(total) is not int or not 0 <= index < total <= 256:
            raise ValueError('invalid chunk index/total (max 256)')
        if not 0 < len(data) <= 4*1024*1024:
            raise ValueError('chunk must be 1 byte to 4 MiB')
        with self._lock():
            directory = self._safe(self.root / 'uploads' / id)
            directory.mkdir(exist_ok=True)
            expected = {'sha256': sha256, 'total': total}
            manifest = directory / 'manifest.json'
            previous = self._read(manifest)
            if previous is not None and previous != expected:
                raise ValueError('upload manifest conflict')
            self._write(manifest, expected)
            part = self._safe(directory / str(index))
            if part.exists() and self._bytes(part, 4*1024*1024) != data:
                raise ValueError('chunk conflict')
            part.write_bytes(data)
            if not all((directory / str(i)).exists() for i in range(total)):
                return {'complete': False, 'id': id, 'index': index}
            assembled = self._safe(directory / 'assembled')
            digest = hashlib.sha256()
            with assembled.open('wb') as output:
                for i in range(total):
                    block = self._bytes(directory / str(i), 4*1024*1024)
                    digest.update(block)
                    output.write(block)
            if digest.hexdigest() != sha256:
                assembled.unlink()
                raise ValueError('asset hash mismatch')
            target = self._safe(self.root / 'assets' / (sha256 + '.png'))
            os.replace(assembled, target)
            with target.open('rb') as source:
                header = source.read(24)
            dimensions = {}
            if header[:8] == b'\x89PNG\r\n\x1a\n' and len(header) == 24:
                w, h = struct.unpack('>II', header[16:24])
                dimensions = {'width': w, 'height': h, 'w': w, 'h': h}
            return {'complete': True, 'path': str(target), 'asset': 'assets/' + target.name,
                    'sha256': sha256, **dimensions}

    def read_asset(self, sha, offset=0, length=1048576):
        import base64
        import re
        if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{64}', sha):
            raise ValueError('invalid asset hash')
        if type(offset) is not int or type(length) is not int or offset < 0 or not 1 <= length <= 1048576:
            raise ValueError('invalid asset read range')
        path = self._safe(self.root / 'assets' / (sha + '.png'))
        with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as handle:
            total = os.fstat(handle.fileno()).st_size
            if offset >= total:
                raise ValueError('asset read offset outside file')
            header = handle.read(12)
            handle.seek(offset)
            data = handle.read(length)
        mime = ('image/png' if header.startswith(b'\x89PNG') else
                'image/jpeg' if header.startswith(b'\xff\xd8\xff') else
                'image/webp' if header[:4] == b'RIFF' and header[8:12] == b'WEBP' else
                'application/octet-stream')
        return {'offset': offset, 'total': total, 'bytes': len(data), 'mime': mime,
                'base64': base64.b64encode(data).decode('ascii')}

    def report(self, update=None):
        with self._lock():
            path = self.root / 'p0-report.json'
            current = self._read(path, {})
            if update is not None:
                def merge(left, right):
                    result = dict(left)
                    for key, value in right.items():
                        result[key] = merge(result[key], value) if isinstance(value, dict) and isinstance(result.get(key), dict) else value
                    return result
                current = merge(current, update)
                self._write(path, current)
            return current

    def wait(self, request_id, timeout=10):
        self._id(request_id)
        import math
        timeout = float(timeout)
        if not math.isfinite(timeout):
            raise ValueError('timeout must be finite')
        deadline = time.monotonic() + min(max(timeout, 0), 10)
        while True:
            response = self._read(self.root / 'responses' / (request_id + '.json'))
            if response is not None:
                return response
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            time.sleep(min(remaining, 0.05))
