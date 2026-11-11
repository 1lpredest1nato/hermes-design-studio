"""Hermes-independent project commands and durable, backend-owned history.

The fsynced global commands.jsonl is the commit record and recovery source.
Per-project project.json and commands.jsonl are materialized under a distinct
.projects.lock (never the render transport's .lock). Each journal record stores
before/after documents so reopening also restores merged undo/redo history.
History replay is linear in journal size; format 1 does not compact journals.
"""
from contextlib import contextmanager
from copy import deepcopy
import fcntl
import json
import os
import re
import math
from pathlib import Path
import uuid


class Conflict(Exception):
    """A stale identity or revision; document is the current detached snapshot."""

    def __init__(self, document):
        super().__init__('project identity or revision conflict')
        self.document = deepcopy(document)


class ProjectStore:
    """One current project per data root, shared safely across processes.

    get() lazily creates the initial project. new() retains earlier projects.
    Mutations require the caller's project_id and base_revision snapshot.
    Invalid commands/metadata raise ValueError; stale identity/revision raises Conflict.
    Empty undo/redo raises ValueError without creating a revision or log row.
    A crash/error after the global WAL commit may have committed the operation:
    callers must get() and inspect last_command_id/revision before retrying.
    """

    def __init__(self, root, catalog):
        self.root = Path(root).absolute()
        if any(path.is_symlink() for path in (self.root, *self.root.parents)):
            raise ValueError('symlink data root is forbidden')
        self.catalog = catalog
        self.root.mkdir(parents=True, exist_ok=True)

    def _safe(self, path):
        path = Path(path).absolute()
        if '..' in path.parts or not path.is_relative_to(self.root):
            raise ValueError('path escapes project data root')
        for part in (path, *path.parents):
            if part.is_symlink():
                raise ValueError('symlink storage is forbidden')
            if part == self.root:
                break
        return path

    @contextmanager
    def _locked(self):
        lock = self._safe(self.root / '.projects.lock')
        with os.fdopen(os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600), 'a+b') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            try:
                self._recover()
                yield
            finally:
                fcntl.flock(handle, fcntl.LOCK_UN)

    def _atomic(self, path, value):
        self._atomic_text(path, json.dumps(value, allow_nan=False))

    def _atomic_text(self, path, text):
        path = self._safe(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
        try:
            with temporary.open('x', encoding='utf-8') as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, path)
            self._sync_directory(path.parent)
        finally:
            temporary.unlink(missing_ok=True)

    @staticmethod
    def _sync_directory(path):
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def _directory(self, project_id):
        if not isinstance(project_id, str) or not re.fullmatch(r'[a-f0-9]{32}', project_id):
            raise ValueError('invalid project id')
        return self._safe(self.root / 'projects' / project_id)

    @staticmethod
    def _format(value, kind):
        if not isinstance(value, dict) or type(value.get('format')) is not int or value['format'] != 1:
            raise ValueError('unsupported ' + kind + ' format; expected format 1')
        return value

    def new(self):
        with self._locked():
            return self._new()

    def _new(self):
        doc = {'format': 1, 'id': uuid.uuid4().hex, 'revision': 0,
               'source': None, 'stack': [], 'seed': 0, 'timeline': None}
        self._atomic(self._directory(doc['id']) / 'project.json', doc)
        self._sync_directory(self._safe(self.root / 'projects'))
        self._atomic(self.root / 'current-project.json', {'format': 1, 'id': doc['id']})
        return doc

    def _append(self, path, record):
        path = self._safe(path)
        created = not path.exists()
        with path.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(record, allow_nan=False) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        if created:
            self._sync_directory(path.parent)

    @staticmethod
    def _metadata(base_revision, source, gesture_id=None):
        if type(base_revision) is not int or base_revision < 0:
            raise ValueError('base_revision must be a nonnegative integer')
        if source not in ('ui', 'agent'):
            raise ValueError('source must be ui or agent')
        if gesture_id is not None and (not isinstance(gesture_id, str) or not gesture_id):
            raise ValueError('gesture_id must be nonempty text or null')

    def apply(self, base_revision, commands, source='ui', gesture_id=None, *, project_id=None):
        self._identity(project_id)
        self._metadata(base_revision, source, gesture_id)
        if not isinstance(commands, list) or not commands:
            raise ValueError('commands must be a nonempty list')
        with self._locked():
            before = self._load()
            if project_id != before['id'] or base_revision != before['revision']:
                raise Conflict(before)
            document = deepcopy(before)
            for command in commands:
                self._command(document, command)
            return self._commit(before, document, commands, source, gesture_id, 'apply')

    def _commit(self, before, document, commands, source, gesture_id, action):
        command_id = uuid.uuid4().hex
        document = deepcopy(document)
        document['revision'] = before['revision'] + 1
        document['last_command_id'] = command_id
        record = {'format': 1, 'id': command_id, 'project_id': document['id'],
                  'source': source, 'base_revision': before['revision'],
                  'revision': document['revision'], 'commands': deepcopy(commands),
                  'gesture_id': gesture_id, 'action': action,
                  'before': before, 'document': document}
        self._append(self.root / 'commands.jsonl', record)
        self._append(self._directory(document['id']) / 'commands.jsonl', record)
        self._atomic(self._directory(document['id']) / 'project.json', document)
        return {'document': document, 'command_id': command_id,
                'base_revision': before['revision'], 'revision': document['revision']}

    def _records(self):
        """Global write-ahead journal: only newline-terminated records commit."""
        path = self._safe(self.root / 'commands.jsonl')
        if not path.exists():
            return []
        data = path.read_bytes()
        end = data.rfind(b'\n') + 1
        records = [self._format(json.loads(line), 'command journal')
                   for line in data[:end].splitlines()]
        # Validate complete records before touching a torn, uncommitted tail.
        if end != len(data):
            with path.open('r+b') as handle:
                handle.truncate(end)
                handle.flush()
                os.fsync(handle.fileno())
        return records

    def _recover(self):
        """Repair materialized project files after a committed WAL append.

        All readers hold .projects.lock, so they never observe a half-published
        batch. The global journal is authoritative; project logs are mirrors.
        """
        grouped = {}
        for record in self._records():
            grouped.setdefault(record['project_id'], []).append(record)
        for project_id, records in grouped.items():
            directory = self._directory(project_id)
            path = self._safe(directory / 'project.json')
            document = self._format(json.loads(path.read_text()), 'project') if path.exists() else None
            latest = self._format(records[-1]['document'], 'journal document')
            if document != latest:
                self._atomic(path, latest)
            log = self._safe(directory / 'commands.jsonl')
            expected = ''.join(json.dumps(record, allow_nan=False) + '\n' for record in records)
            actual = log.read_text() if log.exists() else ''
            if actual != expected:
                for line in actual.splitlines(keepends=True):
                    if line.endswith('\n'):
                        self._format(json.loads(line), 'project journal')
                self._atomic_text(log, expected)


    def _history(self, project_id):
        undo, redo = [], []
        previous = None
        for record in self._records():
            prior, previous = previous, record
            if record['project_id'] != project_id:
                continue
            if record['action'] == 'apply':
                merge = (undo and record['gesture_id'] is not None and prior
                         and prior['action'] == 'apply'
                         and all(prior[key] == record[key] for key in ('project_id', 'source', 'gesture_id')))
                if merge:
                    undo[-1]['after'] = record['document']
                else:
                    undo.append({'before': record['before'], 'after': record['document']})
                redo.clear()
            elif record['action'] == 'undo':
                redo.append(undo.pop())
            elif record['action'] == 'redo':
                undo.append(redo.pop())
        return undo, redo

    @staticmethod
    def _identity(project_id):
        if not isinstance(project_id, str) or not project_id:
            raise ValueError('project_id must be explicit nonempty text')

    def undo(self, base_revision, source='ui', *, project_id=None):
        return self._navigate(base_revision, source, 'undo', project_id)

    def redo(self, base_revision, source='ui', *, project_id=None):
        return self._navigate(base_revision, source, 'redo', project_id)

    def _navigate(self, base_revision, source, action, project_id):
        self._identity(project_id)
        self._metadata(base_revision, source)
        with self._locked():
            before = self._load()
            if project_id != before['id'] or base_revision != before['revision']:
                raise Conflict(before)
            undo, redo = self._history(before['id'])
            entries = undo if action == 'undo' else redo
            if not entries:
                raise ValueError('nothing to ' + action)
            document = entries[-1]['before' if action == 'undo' else 'after']
            return self._commit(before, document, [], source, None, action)

    @staticmethod
    def _fields(value, required, optional=()):
        if (not isinstance(value, dict) or not set(required) <= value.keys()
                or value.keys() - set(required) - set(optional)):
            raise ValueError('missing or unsupported fields')

    @staticmethod
    def _index(index, maximum):
        if type(index) is not int or not 0 <= index <= maximum:
            raise ValueError('node index out of range')
        return index

    @staticmethod
    def _node_fields(fields):
        if 'enabled' in fields and type(fields['enabled']) is not bool:
            raise ValueError('enabled must be bool')
        if 'opacity' in fields:
            opacity = fields['opacity']
            if type(opacity) not in (int, float) or not 0 <= opacity <= 1 or not math.isfinite(opacity):
                raise ValueError('opacity must be finite in 0..1')
        if 'blend' in fields and fields['blend'] not in ('normal', 'multiply', 'screen', 'overlay'):
            raise ValueError('unknown blend mode')

    def _command(self, document, command):
        schemas = {
            'add_node': (('type', 'tool'), ('params', 'uid', 'index')),
            'remove_node': (('type', 'uid'), ()),
            'move_node': (('type', 'uid', 'index'), ()),
            'set_params': (('type', 'uid', 'params'), ()),
            'set_node': (('type', 'uid'), ('enabled', 'opacity', 'blend')),
            'set_source': (('type', 'source'), ()),
            'set_seed': (('type', 'seed'), ()),
            'apply_recipe': (('type', 'stack'), ()),
        }
        if not isinstance(command, dict) or not isinstance(command.get('type'), str) or command['type'] not in schemas:
            raise ValueError('unknown command type')
        self._fields(command, *schemas[command['type']])
        if command['type'] == 'add_node':
            ref = command['tool']
            self.catalog.resolve(ref)
            params = self.catalog.validate_params(ref, command.get('params', {}))
            uid = command.get('uid', uuid.uuid4().hex)
            if not isinstance(uid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', uid) or any(n['uid'] == uid for n in document['stack']):
                raise ValueError('node uid must be nonempty and unique')
            index = self._index(command.get('index', len(document['stack'])), len(document['stack']))
            document['stack'].insert(index, {
                'uid': uid, 'tool': ref,
                'params': params, 'enabled': True, 'opacity': 1.0, 'blend': 'normal'})
        elif command['type'] in {'remove_node', 'move_node', 'set_params', 'set_node'}:
            stack = document['stack']
            node = next((n for n in stack if n['uid'] == command['uid']), None)
            if node is None:
                raise ValueError('unknown node uid')
            if command['type'] == 'remove_node':
                stack.remove(node)
            elif command['type'] == 'move_node':
                index = self._index(command['index'], len(stack) - 1)
                stack.remove(node)
                stack.insert(index, node)
            elif command['type'] == 'set_params':
                if not isinstance(command['params'], dict):
                    raise ValueError('params must be an object')
                node['params'] = self.catalog.validate_params(
                    node['tool'], {**node['params'], **command['params']})
            else:
                self._node_fields(command)
                for key in ('enabled', 'opacity', 'blend'):
                    if key in command:
                        node[key] = command[key]
        elif command['type'] == 'set_source':
            source = command['source']
            self._fields(source, ('asset', 'w', 'h'))
            if (not isinstance(source['asset'], str)
                    or not re.fullmatch(r'assets/[a-f0-9]{64}\.png', source['asset'])
                    or any(type(source[key]) is not int or source[key] <= 0 for key in ('w', 'h'))):
                raise ValueError('source requires a safe PNG asset and positive integer dimensions')
            document['source'] = deepcopy(source)
        elif command['type'] == 'set_seed':
            if type(command['seed']) is not int:
                raise ValueError('seed must be an integer')
            document['seed'] = command['seed']
        elif command['type'] == 'apply_recipe':
            if not isinstance(command['stack'], list) or not command['stack']:
                raise ValueError('recipe stack must be a nonempty list')
            for spec in command['stack']:
                self._fields(spec, ('tool',), ('uid', 'params', 'enabled', 'opacity', 'blend'))
                self._command(document, {'type': 'add_node', 'tool': spec['tool'],
                                         'params': spec.get('params', {})})
                properties = {key: spec[key] for key in ('enabled', 'opacity', 'blend') if key in spec}
                self._command(document, {'type': 'set_node', 'uid': document['stack'][-1]['uid'], **properties})
        else:
            raise ValueError('unknown command type')

    def get(self):
        with self._locked():
            return self._load()

    def _load(self):
        pointer = self._safe(self.root / 'current-project.json')
        if not pointer.exists():
            return self._new()
        value = self._format(json.loads(pointer.read_text()), 'project pointer')
        if set(value) != {'format', 'id'}:
            raise ValueError('invalid project pointer fields')
        project_id = value['id']
        document = self._format(json.loads(self._safe(self._directory(project_id) / 'project.json').read_text()), 'project')
        self._records()
        return document
