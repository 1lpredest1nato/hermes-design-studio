"""Hermes-independent tool catalog. Static checks are not a GPU sandbox."""
import re
import json
from pathlib import Path
import math
import hashlib
import os
import shutil
import uuid
import fcntl
import unicodedata
from datetime import datetime, timezone
from contextlib import contextmanager
from copy import deepcopy
from typing import Any


def _slug(name):
    _text(name, 'name', True)
    text = unicodedata.normalize('NFKD', name).encode('ascii', 'ignore').decode().lower()
    slug = re.sub('[^a-z0-9]+', '-', text).strip('-')[:64].rstrip('-')
    return slug or 'tool-' + hashlib.sha256(name.encode()).hexdigest()[:12]


def _sha(shader):
    return hashlib.sha256(shader.encode('utf-8')).hexdigest()


def _manifest_sha(manifest):
    return _sha(json.dumps(manifest, sort_keys=True, ensure_ascii=False, allow_nan=False))


def _safe(path, root):
    try:
        if not path.resolve().is_relative_to(root.resolve()):
            raise ValueError(f'path escapes outside catalog root: {path}')
    except (OSError, RuntimeError) as exc:
        raise ValueError(f'invalid catalog path or symlink: {path}') from exc
    return path


def _json_read(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError) as exc:
        raise ValueError(f'cannot read {path}: {exc}') from exc


def _json_write(path, value):
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False, indent=2)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name('.' + path.name + '.' + uuid.uuid4().hex)
    try:
        with temp.open('x', encoding='utf-8') as stream:
            stream.write(encoded)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()


_ID = re.compile(r'(builtin|user)/[a-z0-9][a-z0-9_-]{0,79}', re.ASCII)
_RESERVED = set(('main input output outColor v_uv float int bool void true false '
                 'uniform varying attribute const in out inout for while do if else return '
                 'break continue discard struct precision sampler2D vec2 vec3 vec4 mat2 mat3 mat4 '
                 'uint uvec2 uvec3 uvec4 ivec2 ivec3 ivec4 bvec2 bvec3 bvec4 '
                 'switch case default layout highp mediump lowp invariant centroid flat smooth '
                 'sampler3D samplerCube sampler2DShadow samplerCubeShadow sampler2DArray '
                 'sampler2DArrayShadow isampler2D isampler3D isamplerCube isampler2DArray '
                 'usampler2D usampler3D usamplerCube usampler2DArray '
                 'mat2x2 mat2x3 mat2x4 mat3x2 mat3x3 mat3x4 mat4x2 mat4x3 mat4x4 '
                 'common partition active asm class union enum typedef template this resource goto '
                 'inline noinline public static extern external interface long short double half fixed '
                 'unsigned superp dvec2 dvec3 dvec4 fvec2 fvec3 fvec4 sampler1D sampler1DShadow '
                 'samplerRect sampler3DRect sampler2DRect sizeof cast namespace using row_major').split())


def _text(value, field, nonempty=False):
    if not isinstance(value, str) or (nonempty and not value.strip()) or '\x00' in value:
        raise ValueError(f'{field} must be text' + (' and nonempty' if nonempty else ''))
    return value


def _number(value):
    try:
        return type(value) in (int, float) and math.isfinite(value)
    except OverflowError:
        return False


def _param_value(p: dict[str, Any], value: Any) -> Any:
    name, kind = p['name'], p['type']
    if kind in ('float', 'int'):
        if not _number(value) or (kind == 'int' and type(value) is not int):
            raise ValueError(f'parameter {name} requires {kind}')
        if not p['min'] <= value <= p['max']:
            raise ValueError(f'parameter {name} outside range [{p["min"]}, {p["max"]}]')
        return float(value) if kind == 'float' else value
    if kind == 'bool':
        if type(value) is not bool:
            raise ValueError(f'parameter {name} requires bool')
    elif kind == 'color':
        if not isinstance(value, str) or not re.fullmatch(r'#[0-9a-fA-F]{6}', value):
            raise ValueError(f'parameter {name} requires #RRGGBB')
        return value.lower()
    elif kind == 'enum':
        if not isinstance(value, str) or value not in p['options']:
            raise ValueError(f'parameter {name} is not an enum option')
    return value


def _validate_definitions(params: Any) -> list[dict[str, Any]]:
    if not isinstance(params, list):
        raise ValueError('manifest params must be a list')
    names = set()
    for p in params:
        if not isinstance(p, dict):
            raise ValueError('manifest parameter must be an object')
        name = p.get('name')
        if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', name)
                or '__' in name or name.startswith(('gl_', 'u_', 'v_', 'p_'))
                or name in _RESERVED or name in names):
            raise ValueError(f'invalid, reserved or duplicate parameter name: {name}')
        names.add(name)
        kind = p.get('type')
        if kind not in ('float', 'int', 'bool', 'color', 'enum'):
            raise ValueError(f'unsupported parameter type: {kind}')
        if 'default' not in p:
            raise ValueError(f'parameter {name} needs a default')
        if kind in ('float', 'int'):
            low, high = p.get('min'), p.get('max')
            if (low is None or high is None or not _number(low) or not _number(high) or low > high
                    or (kind == 'int' and (type(low) is not int or type(high) is not int))):
                raise ValueError(f'parameter {name} requires a valid min/max range')
        if kind == 'enum':
            options = p.get('options')
            if (not isinstance(options, list) or not options
                    or any(not isinstance(o, str) or not o for o in options)
                    or len(set(options)) != len(options)):
                raise ValueError(f'parameter {name} needs distinct enum options')
        _param_value(p, p['default'])
        if 'label' in p:
            _text(p['label'], 'parameter label')
    return params


def validate_manifest(manifest: Any) -> dict[str, Any]:
    """Validate format 1 shader manifest without rewriting supplied values."""
    if not isinstance(manifest, dict):
        raise ValueError('manifest must be an object')
    if type(manifest.get('format')) is not int or manifest['format'] != 1:
        raise ValueError('manifest format must be 1; unsupported format')
    ident = manifest.get('id')
    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        raise ValueError('manifest id must be builtin/<slug> or user/<slug>')
    if type(manifest.get('version')) is not int or manifest['version'] < 1:
        raise ValueError('manifest version must be a positive integer')
    _text(manifest.get('name'), 'manifest name', True)
    _text(manifest.get('description'), 'manifest description')
    if manifest.get('kind') != 'shader':
        raise ValueError('manifest kind must be shader')
    if manifest.get('shader') != 'shader.frag':
        raise ValueError('manifest shader must be shader.frag')
    definitions = _validate_definitions(manifest.get('params'))
    if 'provenance' in manifest:
        provenance = manifest['provenance']
        if not isinstance(provenance, dict):
            raise ValueError('manifest provenance must be an object')
        for key in ('author', 'created', 'from_prompt'):
            if key in provenance:
                _text(provenance[key], 'manifest provenance ' + key)
    if 'license' in manifest:
        _text(manifest['license'], 'manifest license', True)
    if 'examples' in manifest:
        examples = manifest['examples']
        if not isinstance(examples, list):
            raise ValueError('manifest examples must be a list')
        for example in examples:
            if not isinstance(example, dict) or not isinstance(example.get('params'), dict):
                raise ValueError('manifest example requires params object')
            if set(example['params']) - {p['name'] for p in definitions}:
                raise ValueError('manifest example has unknown parameter')
            for p in definitions:
                _param_value(p, example['params'].get(p['name'], p['default']))
    return manifest


class Catalog:
    def __init__(self, root, builtin_root):
        self.root = Path(root).resolve()
        self.builtin_root = Path(builtin_root).resolve()

    def _data_path(self, *parts):
        return _safe(self.root.joinpath(*parts), self.root)

    def _entry(self, path: Path, status: str) -> dict[str, Any]:
        try:
            base = self.builtin_root if status == 'builtin' else self.root
            _safe(path, base)
            manifest = validate_manifest(json.loads(path.read_text(encoding='utf-8')))
            expected_id = ('builtin/' + path.parent.name if status == 'builtin' else
                           'user/' + path.parent.parent.name)
            if manifest['id'] != expected_id or (status == 'approved' and str(manifest['version']) != path.parent.name):
                raise ValueError('manifest identity/namespace does not match storage path')
            shader = _safe(path.parent / manifest['shader'], base).read_text(encoding='utf-8')
            validate_shader(shader)
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise ValueError(f'cannot load manifest {path}: {exc}') from exc
        return dict(manifest=manifest, shader=shader, status=status,
                    ref=f"{manifest['id']}@{manifest['version']}")

    @contextmanager
    def _lock(self):
        self.root.mkdir(parents=True, exist_ok=True)
        with self._data_path('.catalog.lock').open('a') as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(stream, fcntl.LOCK_UN)

    def _draft_path(self, ident):
        if not isinstance(ident, str) or not _ID.fullmatch(ident) or not ident.startswith('user/'):
            raise ValueError('draft id must be user/<slug>')
        return self._data_path('drafts', ident.split('/')[1], 'entry.json')

    def _draft(self, ident: str) -> dict[str, Any]:
        path = self._draft_path(ident)
        entry = _json_read(path)
        if not isinstance(entry, dict):
            raise ValueError(f'invalid draft entry: {path}')
        validate_manifest(entry.get('manifest'))
        validate_shader(entry.get('shader'))
        if entry['manifest']['id'] != ident:
            raise ValueError('draft manifest id mismatch')
        return self._fingerprint(entry)

    @staticmethod
    def _fingerprint(entry):
        return {**entry, 'expected_shader_sha': _sha(entry['shader']),
                'expected_manifest_sha': _manifest_sha(entry['manifest'])}

    @staticmethod
    def _expect_snapshot(entry, expected_shader_sha, expected_manifest_sha):
        for key, actual, expected in [('shader', _sha(entry['shader']), expected_shader_sha),
                                      ('manifest', _manifest_sha(entry['manifest']), expected_manifest_sha)]:
            if expected is not None and expected != actual:
                raise ValueError(f'{key} snapshot does not match current draft; refresh and check again')

    def draft_snapshot(self, id, expected_shader_sha=None, expected_manifest_sha=None):
        with self._lock():
            entry = self._draft(id)
            self._expect_snapshot(entry, expected_shader_sha, expected_manifest_sha)
            return entry

    def create_draft(self, name, description, params, shader, author='user', from_prompt='') -> dict[str, Any]:
        ident = 'user/' + _slug(name)
        _text(description, 'description')
        _text(from_prompt, 'from_prompt')
        if author not in ('user', 'agent'):
            raise ValueError('author must be user or agent')
        validate_shader(shader)
        with self._lock():
            path = self._draft_path(ident)
            if path.exists():
                previous = self._draft(ident)  # Never overwrite a corrupt draft.
                if previous['manifest']['name'] != name:
                    raise ValueError('draft slug collision with a different name')
            approved = [e for e in self._tools() if e['manifest']['id'] == ident]
            if any(e['manifest']['name'] != name for e in approved):
                raise ValueError('approved tool slug collision with a different name')
            versions = [e['manifest']['version'] for e in approved]
            manifest = dict(format=1, id=ident, version=max(versions, default=0) + 1,
                            name=name, description=description, kind='shader', params=deepcopy(params),
                            shader='shader.frag', license='MIT', provenance=dict(author=author,
                            created=datetime.now(timezone.utc).isoformat(), from_prompt=from_prompt))
            validate_manifest(manifest)
            entry = dict(manifest=manifest, shader=shader, status='draft',
                         ref=f"{ident}@{manifest['version']}", check=None)
            _json_write(path, entry)
            return self._fingerprint(entry)

    def record_check(self, id, shader_sha, result, expected_manifest_sha=None) -> dict[str, Any]:
        """Correlate the backend request snapshot while holding the write lock."""
        with self._lock():
            entry = self._draft(id)
            if (expected_manifest_sha is not None and
                    expected_manifest_sha != _manifest_sha(entry['manifest'])):
                raise ValueError('check manifest snapshot does not match current draft')
            if shader_sha != _sha(entry['shader']):
                raise ValueError('check shader hash does not match current draft')
            if not isinstance(result, dict) or type(result.get('ok')) is not bool:
                raise ValueError('check result requires boolean ok')
            entry['check'] = dict(shader_sha=shader_sha, manifest_sha=_manifest_sha(entry['manifest']),
                                  result=deepcopy(result))
            _json_write(self._draft_path(id), entry)
            return entry

    def approve_draft(self, id, expected_shader_sha=None, expected_manifest_sha=None) -> dict[str, Any]:
        """Human-only adapter route; never expose this method as an agent tool."""
        with self._lock():
            entry = self._draft(id)
            self._expect_snapshot(entry, expected_shader_sha, expected_manifest_sha)
            check = entry.get('check')
            if (not isinstance(check, dict) or check.get('shader_sha') != _sha(entry['shader'])
                    or check.get('manifest_sha') != _manifest_sha(entry['manifest'])
                    or not isinstance(check.get('result'), dict) or check['result'].get('ok') is not True):
                raise ValueError('draft requires a successful check for exact current shader hash')
            versions = [e['manifest']['version'] for e in self._tools() if e['manifest']['id'] == id]
            version = max(versions, default=0) + 1
            entry['manifest']['version'] = version
            target = self._data_path('tools', id.split('/')[1], str(version))
            if target.exists():
                raise ValueError(f'approved version directory already exists or is incomplete: {target}')
            target.parent.mkdir(parents=True, exist_ok=True)
            staging = target.with_name('.pending-' + uuid.uuid4().hex)
            staging.mkdir()
            try:
                _json_write(staging / 'manifest.json', entry['manifest'])
                (staging / 'shader.frag').write_text(entry['shader'], encoding='utf-8')
                os.rename(staging, target)
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
            # Approval explicitly consumes this draft; older approved versions remain.
            self._draft_path(id).unlink()
            if not any(self._draft_path(id).parent.iterdir()):
                self._draft_path(id).parent.rmdir()
            return self._entry(target / 'manifest.json', 'approved')

    def delete_draft(self, id) -> dict[str, Any]:
        with self._lock():
            entry = self._draft(id)
            self._draft_path(id).unlink()
            if not any(self._draft_path(id).parent.iterdir()):
                self._draft_path(id).parent.rmdir()
            return entry

    def _tools(self) -> list[dict[str, Any]]:
        tools = [self._entry(p, 'builtin') for p in sorted(self.builtin_root.glob('*/manifest.json'))]
        tools += [self._entry(p, 'approved') for p in sorted(self._data_path('tools').glob('*/*/manifest.json'))
                  if not p.parent.name.startswith('.')]
        return tools

    def list(self) -> dict[str, Any]:
        with self._lock():
            drafts = [self._draft('user/' + p.parent.name)
                      for p in sorted(self._data_path('drafts').glob('*/entry.json'))]
            return dict(tools=self._tools(), drafts=drafts, recipes=self.list_recipes())

    def resolve(self, ref) -> dict[str, Any]:
        if not isinstance(ref, str) or not re.fullmatch(r'(builtin|user)/[a-z0-9][a-z0-9_-]*@[1-9][0-9]*', ref):
            raise ValueError('invalid tool version reference')
        ident, version = ref.split('@')
        namespace, slug = ident.split('/')
        path = (self.builtin_root / slug / 'manifest.json' if namespace == 'builtin' else
                self.root / 'tools' / slug / version / 'manifest.json')
        if not path.exists():
            raise ValueError(f'unknown tool or version: {ref}')
        entry = self._entry(path, 'builtin' if namespace == 'builtin' else 'approved')
        if entry['ref'] != ref:
            raise ValueError(f'unknown tool version or manifest identity mismatch: {ref}')
        return entry

    def _validate_recipe(self, recipe: Any, expected_id: str) -> dict[str, Any]:
        if not isinstance(recipe, dict):
            raise ValueError('recipe must be an object')
        if type(recipe.get('format')) is not int or recipe['format'] != 1:
            raise ValueError('unsupported recipe format; expected 1')
        if recipe.get('id') != expected_id:
            raise ValueError('recipe id mismatch')
        _text(recipe.get('name'), 'recipe name', True)
        stack, exposed = recipe.get('stack'), recipe.get('exposed')
        if not isinstance(stack, list) or not stack:
            raise ValueError('recipe stack must be a nonempty list')
        nodes = {}
        for node in stack:
            if not isinstance(node, dict):
                raise ValueError('recipe node must be an object')
            uid = node.get('uid')
            if not isinstance(uid, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', uid) or uid in nodes:
                raise ValueError('recipe node uid missing, invalid or duplicate')
            if set(node) - {'uid', 'tool', 'params', 'enabled', 'opacity', 'blend'}:
                raise ValueError('unsupported recipe node fields')
            tool = self.resolve(node.get('tool'))
            node['params'] = self.validate_params(tool['ref'], node.get('params', {}))
            if type(node.get('enabled', True)) is not bool:
                raise ValueError('recipe node enabled must be bool')
            opacity = node.get('opacity', 1.0)
            if not _number(opacity) or not 0 <= opacity <= 1:
                raise ValueError('recipe node opacity must be 0..1')
            if node.get('blend', 'normal') not in ('normal', 'multiply', 'screen', 'overlay'):
                raise ValueError('invalid recipe node blend')
            node.setdefault('enabled', True)
            node.setdefault('opacity', 1.0)
            node.setdefault('blend', 'normal')
            nodes[uid] = {p['name'] for p in tool['manifest']['params']}
        if not isinstance(exposed, list):
            raise ValueError('recipe exposed must be a list')
        names = set()
        for descriptor in exposed:
            if not isinstance(descriptor, dict) or set(descriptor) != {'name', 'node_uid', 'param'}:
                raise ValueError('exposed descriptor requires name, node_uid, param')
            name, uid, param = descriptor['name'], descriptor['node_uid'], descriptor['param']
            if not isinstance(name, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,63}', name) or name in names:
                raise ValueError('invalid or duplicate exposed name')
            if not isinstance(uid, str) or uid not in nodes or not isinstance(param, str) or param not in nodes[uid]:
                raise ValueError('exposed parameter target does not exist')
            names.add(name)
        return recipe

    def save_recipe(self, name, stack, exposed=None) -> dict[str, Any]:
        recipe: dict[str, Any] = dict(format=1, id='recipe/' + _slug(name), name=name,
                      stack=deepcopy(stack), exposed=deepcopy(exposed if exposed is not None else []))
        self._validate_recipe(recipe, recipe['id'])
        with self._lock():
            path = self._data_path('recipes', recipe['id'].split('/')[1] + '.json')
            if path.exists():
                previous = self.get_recipe(recipe['id'])
                if previous['name'] != name:
                    raise ValueError('recipe slug collision with a different name')
            _json_write(path, recipe)
        return recipe

    def get_recipe(self, id) -> dict[str, Any]:
        if not isinstance(id, str) or not re.fullmatch(r'recipe/[a-z0-9][a-z0-9_-]{0,79}', id):
            raise ValueError('invalid recipe id')
        return self._validate_recipe(_json_read(self._data_path('recipes', id.split('/')[1] + '.json')), id)

    def list_recipes(self) -> list[dict[str, Any]]:
        return [self.get_recipe('recipe/' + p.stem) for p in sorted((self.root / 'recipes').glob('*.json'))]

    def validate_params(self, ref, params) -> dict[str, Any]:
        if not isinstance(params, dict):
            raise ValueError('params must be an object')
        definitions = self.resolve(ref)['manifest']['params']
        if set(params) - {p['name'] for p in definitions}:
            raise ValueError('unknown parameter name')
        return {p['name']: _param_value(p, params.get(p['name'], p['default'])) for p in definitions}


def validate_shader(shader):
    """Validate the deliberately small supported shader loop subset."""
    if not isinstance(shader, str):
        raise ValueError('shader must be text')
    try:
        size = len(shader.encode('utf-8'))
    except UnicodeError as exc:
        raise ValueError('shader is not valid UTF-8') from exc
    if size > 32768:
        raise ValueError('shader exceeds 32 KiB UTF-8')
    if '\\' in shader or '\x00' in shader:
        raise ValueError('shader contains forbidden backslash or NUL')
    # Replace comments with whitespace, never concatenate adjacent tokens.
    code = re.sub(r'/\*.*?\*/|//[^\r\n]*', ' ', shader, flags=re.S)
    if '/*' in code or '*/' in code:
        raise ValueError('unterminated or malformed shader comment')
    if '#' in code or re.search(r'\b(?:while|do)\b', code):
        raise ValueError('preprocessor directives and while/do loops are unsupported')
    loop = re.compile(r'\bfor\s*\(\s*int\s+([A-Za-z_]\w*)\s*=\s*0\s*;\s*'
                      r'\1\s*(<=|<)\s*(0|[1-9][0-9]*)\s*;\s*'
                      r'(?:\1\s*\+\+|\+\+\s*\1)\s*\)\s*\{', re.ASCII)
    for token in re.finditer(r'\bfor\b', code):
        match = loop.match(code, token.start())
        if not match:
            raise ValueError('for requires int counter=0, literal bound and ++, braced body')
        counter, op, bound = match.group(1, 2, 3)
        if len(bound) > 3 or int(bound) + (op == '<=') > 256:
            raise ValueError('for loop exceeds 256 iterations')
        depth, end = 1, match.end()
        while end < len(code) and depth:
            depth += (code[end] == '{') - (code[end] == '}')
            end += 1
        if depth:
            raise ValueError('unclosed for loop body')
        # Parentheses preserve lvalues in GLSL: ((i))=0 and ++(i) mutate i.
        body = re.sub(r'[()]', ' ', code[match.end():end - 1])
        if (re.search(r'\b' + re.escape(counter) + r'\s*(?:(?:<<|>>|[+\-*/%&|^])?=(?!=)|\+\+|--)', body)
                or re.search(r'(?:\+\+|--)\s*\b' + re.escape(counter) + r'\b', body)
                or re.search(r'\b(?:inout|out|frexp|uaddCarry|usubBorrow|umulExtended|imulExtended)\b', code)):
            raise ValueError('loop counter mutation is unsupported')
    return shader
