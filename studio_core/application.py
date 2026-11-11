"""Hermes-independent application composition over one plugin-data root."""
from pathlib import Path

from .bridge import Store
from .catalog import Catalog
from .projects import ProjectStore


class Application:
    def __init__(self, root, builtin_root=None):
        self.root = Path(root).absolute()
        self.catalog = Catalog(self.root, builtin_root if builtin_root is not None else
                               Path(__file__).resolve().parents[1] / 'tools' / 'builtin')
        self.projects = ProjectStore(self.root, self.catalog)
        self.bridge = Store(self.root, document_provider=self.projects.get)

    def state(self):
        return {**self.bridge.state(), 'catalog': self.catalog.list()}

    def diagnostics(self, report=None):
        with self.bridge._lock():
            path = self.root / 'diagnostics.json'
            if report is not None:
                if not isinstance(report, dict):
                    raise ValueError('diagnostics must be a JSON object')
                self.bridge._write(path, report)
            return self.bridge._read(path, {})

    def check_draft(self, id, fixture=False, params=None, expected_shader_sha=None, expected_manifest_sha=None):
        if type(fixture) is not bool or (params is not None and not isinstance(params, dict)):
            raise ValueError('fixture must be boolean and params must be an object')
        entry = self.catalog.draft_snapshot(id, expected_shader_sha, expected_manifest_sha)
        import hashlib
        return self.bridge.request('check', id=id, draft_id=id, entry=entry,
                                   shader_sha=hashlib.sha256(entry['shader'].encode('utf-8')).hexdigest(),
                                   fixture=fixture, params={} if params is None else params)

    def render_result(self, id):
        self.bridge._id(id)
        if self.bridge._read(self.root / 'requests' / (id + '.json')) is None:
            raise ValueError('unknown request')
        return self.bridge.wait(id, 0) or {'pending': True}

    def _record_check(self, id, receipt):
        request = self.bridge._read(self.root / 'requests' / (id + '.json'))
        if request['kind'] != 'check':
            return
        # Identity and hash come exclusively from our durable request, never meta.
        entry = next((entry for entry in self.catalog.list()['drafts']
                      if entry['manifest']['id'] == request.get('draft_id')), None)
        if entry is None:
            return  # Deleted/approved draft; late responses cannot revive it.
        import hashlib
        if (entry['manifest'] != request.get('entry', {}).get('manifest') or
                hashlib.sha256(entry['shader'].encode('utf-8')).hexdigest() != request.get('shader_sha')):
            return  # Stale compile result must not validate an edited draft.
        # record_check re-compares both snapshots under its write lock. The
        # earlier list is only an optimization, never the approval authority.
        from .catalog import _manifest_sha
        try:
            self.catalog.record_check(request['draft_id'], request['shader_sha'],
                                      {'ok': 'error' not in receipt, 'receipt': receipt},
                                      expected_manifest_sha=_manifest_sha(request['entry']['manifest']))
        except ValueError:
            # Deleted or edited between list and record: retain the durable
            # transport receipt without applying it to a different draft.
            return

    def respond(self, id, png, meta):
        receipt = self.bridge.respond(id, png, meta)
        self._record_check(id, receipt)
        return receipt

    def fail(self, id, error):
        receipt = self.bridge.fail(id, error)
        self._record_check(id, receipt)
        return receipt

