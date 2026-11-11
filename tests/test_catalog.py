"""Catalog contract tests. All runtime fixtures stay under evidence/scratch."""
import hashlib
import json
import shutil
import sys
import tempfile
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
SCRATCH = Path(__file__).resolve().parents[1] / 'evidence' / 'scratch'
SHADER = 'void main() { outColor = texture(u_input, v_uv); }'


@pytest.fixture
def roots():
    SCRATCH.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix='catalog-', dir=SCRATCH))
    yield root / 'data', root / 'builtin'
    shutil.rmtree(root)


def manifest(params=None):
    return dict(format=1, id='builtin/test', version=1, name='Test', description='',
                kind='shader', params=params or [], shader='shader.frag')


def builtin(roots, params=None):
    data, builtins = roots
    path = builtins / 'test'
    path.mkdir(parents=True, exist_ok=True)
    (path / 'manifest.json').write_text(json.dumps(manifest(params)))
    (path / 'shader.frag').write_text(SHADER)
    from studio_core.catalog import Catalog
    return Catalog(data, builtins)


PARAMS = [dict(name='gain', type='float', min=0, max=2, default=1),
          dict(name='steps', type='int', min=1, max=8, default=4),
          dict(name='on', type='bool', default=True),
          dict(name='tint', type='color', default='#AABBCC'),
          dict(name='mode', type='enum', options=['a', 'b'], default='a')]


def test_check_manifest_snapshot_is_compared_under_catalog_lock(roots):
    from studio_core.catalog import _manifest_sha
    cat = builtin(roots, PARAMS)
    draft = cat.create_draft('Race', '', [], SHADER)
    snapshot = _manifest_sha(draft['manifest'])
    cat.create_draft('Race', '', PARAMS, SHADER)
    with pytest.raises(ValueError, match='manifest'):
        cat.record_check('user/race', hashlib.sha256(SHADER.encode()).hexdigest(),
                         {'ok': True}, expected_manifest_sha=snapshot)
    assert cat.list()['drafts'][0]['check'] is None
    with pytest.raises(ValueError, match='check'):
        cat.approve_draft('user/race')


@pytest.mark.parametrize('edit', ['shader', 'params'])
def test_editor_snapshot_comparison_and_approval_hold_catalog_lock(roots, monkeypatch, edit):
    from contextlib import contextmanager
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    a = cat.create_draft('Snapshot', '', [], SHADER)
    expected = {key: a[key] for key in ['expected_shader_sha', 'expected_manifest_sha']}
    cat.record_check('user/snapshot', a['expected_shader_sha'], {'ok': True})
    b = cat.create_draft('Snapshot', '', PARAMS if edit == 'params' else [],
                         SHADER + '\n' if edit == 'shader' else SHADER)
    cat.record_check('user/snapshot', b['expected_shader_sha'], {'ok': True})
    lock = cat._lock
    read = cat._draft
    held = False
    @contextmanager
    def tracked_lock():
        nonlocal held
        with lock():
            held = True
            try:
                yield
            finally:
                held = False
    def locked_read(id):
        assert held, 'snapshot read must share the comparison/write lock'
        return read(id)
    monkeypatch.setattr(cat, '_lock', tracked_lock)
    monkeypatch.setattr(cat, '_draft', locked_read)
    for action in [cat.draft_snapshot, cat.approve_draft]:
        with pytest.raises(ValueError, match='snapshot'):
            action('user/snapshot', **expected)
    expected_b = {key: b[key] for key in expected}
    assert cat.draft_snapshot('user/snapshot', **expected_b)['shader'] == b['shader']
    assert cat.approve_draft('user/snapshot', **expected_b)['shader'] == b['shader']


def test_builtin_resolution_normalizes_all_five_param_types(roots):
    cat = builtin(roots, PARAMS)
    entry = cat.resolve('builtin/test@1')
    assert entry == dict(manifest=manifest(PARAMS), shader=SHADER, status='builtin', ref='builtin/test@1')
    assert cat.list() == dict(tools=[entry], drafts=[], recipes=[])
    assert cat.validate_params('builtin/test@1', {'gain': 2, 'mode': 'b'}) == dict(
        gain=2.0, steps=4, on=True, tint='#aabbcc', mode='b')
    for ref in ['builtin/test@2', 'draft/test@1', '../test@1']:
        with pytest.raises(ValueError):
            cat.resolve(ref)


def test_drafts_persist_separately_and_require_exact_successful_check(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    draft = cat.create_draft('Dither Noir', 'description', PARAMS, SHADER, author='agent', from_prompt='noir')
    assert draft['manifest']['id'] == 'user/dither-noir'
    assert draft['manifest']['provenance']['author'] == 'agent'
    assert draft['status'] == 'draft'
    assert cat.list()['drafts'] == [draft]
    assert Catalog(*roots).list()['drafts'] == [draft]
    with pytest.raises(ValueError):
        cat.resolve(draft['ref'])
    with pytest.raises(ValueError, match='check'):
        cat.approve_draft('user/dither-noir')
    sha = hashlib.sha256(SHADER.encode()).hexdigest()
    with pytest.raises(ValueError, match='hash'):
        cat.record_check('user/dither-noir', '0' * 64, {'ok': True})
    failed = cat.record_check('user/dither-noir', sha, {'ok': False, 'error': 'line 4: compile error'})
    assert failed['check']['result']['error'] == 'line 4: compile error'
    with pytest.raises(ValueError, match='check'):
        cat.approve_draft('user/dither-noir')
    checked = cat.record_check('user/dither-noir', sha, {'ok': True, 'metrics': {'mean_luma': .5}})
    assert checked['check']['shader_sha'] == sha
    approved = Catalog(*roots).approve_draft('user/dither-noir')
    assert approved['status'] == 'approved'
    assert approved['ref'] == 'user/dither-noir@1'
    assert cat.resolve(approved['ref']) == approved
    assert cat.list()['drafts'] == []
    assert (roots[0] / 'tools').is_dir()
    updated = cat.create_draft('Dither Noir', 'new', PARAMS, SHADER + '\n')
    assert updated['manifest']['id'] == draft['manifest']['id']
    assert updated.get('check') is None
    with pytest.raises(ValueError, match='check'):
        cat.approve_draft('user/dither-noir')
    cat.record_check('user/dither-noir', hashlib.sha256(updated['shader'].encode()).hexdigest(), {'ok': True})
    approved2 = cat.approve_draft('user/dither-noir')
    assert approved2['ref'] == 'user/dither-noir@2'
    assert cat.resolve(approved['ref']) == approved
    assert cat.resolve(approved2['ref']) == approved2


def test_draft_update_invalidates_check_without_touching_approved_or_other_drafts(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    cat.create_draft('One', '', [], SHADER)
    cat.create_draft('Two', '', [], SHADER)
    sha = hashlib.sha256(SHADER.encode()).hexdigest()
    cat.record_check('user/one', sha, {'ok': True})
    cat.create_draft('One', 'updated metadata', [], SHADER)
    with pytest.raises(ValueError, match='check'):
        cat.approve_draft('user/one')
    cat.delete_draft('user/one')
    assert [e['manifest']['id'] for e in cat.list()['drafts']] == ['user/two']
    with pytest.raises(ValueError):
        cat.delete_draft('user/one')
    with pytest.raises(ValueError):
        cat.delete_draft('user/../../two')


def test_approval_refuses_on_disk_shader_or_manifest_tampering(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    cat.create_draft('One', '', PARAMS, SHADER)
    sha = hashlib.sha256(SHADER.encode()).hexdigest()
    cat.record_check('user/one', sha, {'ok': True})
    path = roots[0] / 'drafts' / 'one' / 'entry.json'
    entry = json.loads(path.read_text())
    entry['shader'] += '\n'
    path.write_text(json.dumps(entry))
    with pytest.raises(ValueError, match='check'):
        cat.approve_draft('user/one')
    entry['shader'] = SHADER
    entry['manifest']['params'][0]['type'] = 'int'
    path.write_text(json.dumps(entry))
    with pytest.raises(ValueError, match='check'):
        cat.approve_draft('user/one')


@pytest.mark.parametrize('result', [None, {}, {'ok': 'true'}, {'ok': 1}, {'ok': True, 'metrics': float('nan')}])
def test_check_requires_explicit_boolean_and_json_safe_result(roots, result):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    before = cat.create_draft('One', '', [], SHADER)
    with pytest.raises(ValueError):
        cat.record_check('user/one', hashlib.sha256(SHADER.encode()).hexdigest(), result)
    assert cat.list()['drafts'] == [before]


def test_slug_collision_and_invalid_update_do_not_overwrite_draft(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    before = cat.create_draft('A B', '', [], SHADER)
    with pytest.raises(ValueError, match='collision'):
        cat.create_draft('A-B', '', [], SHADER)
    with pytest.raises(ValueError):
        cat.create_draft('A B', '', [], 'while(true){}')
    assert cat.list()['drafts'] == [before]


def test_recipes_store_frozen_subchains_and_exposed_parameters(roots):
    from studio_core.catalog import Catalog
    cat = builtin(roots, PARAMS)
    stack = [dict(uid='n1', tool='builtin/test@1', params={'gain': 1.5}, enabled=False, opacity=.5, blend='screen'),
             dict(uid='n2', tool='builtin/test@1', params={})]
    exposed = [dict(name='strength', node_uid='n1', param='gain')]
    recipe = cat.save_recipe('Noir Recipe', stack, exposed)
    assert recipe['format'] == 1
    assert recipe['id'] == 'recipe/noir-recipe'
    assert recipe['stack'][0]['tool'] == 'builtin/test@1'
    assert recipe['stack'][0]['params']['gain'] == 1.5
    assert recipe['stack'][0]['blend'] == 'screen'
    assert recipe['stack'][1]['params']['steps'] == 4
    assert recipe['exposed'] == exposed
    stack[0]['params']['gain'] = 0
    exposed.clear()
    assert Catalog(*roots).get_recipe(recipe['id']) == recipe
    assert cat.list_recipes() == [recipe]
    assert cat.list()['recipes'] == [recipe]
    assert (roots[0] / 'recipes').is_dir()


@pytest.mark.parametrize('stack,exposed', [
    (None, []), ({}, []), ([], []), ([None], []), ([{}], []),
    ([dict(uid='a', tool='builtin/test', params={})], []),
    ([dict(uid='a', tool='builtin/test@2', params={})], []),
    ([dict(uid='a', tool='builtin/test@1', params={'gain': 20})], []),
    ([dict(uid='a', tool='builtin/test@1', enabled=1)], []),
    ([dict(uid='a', tool='builtin/test@1', opacity=True)], []),
    ([dict(uid='a', tool='builtin/test@1', opacity=float('nan'))], []),
    ([dict(uid='a', tool='builtin/test@1', opacity=2)], []),
    ([dict(uid='a', tool='builtin/test@1', blend='invalid')], []),
    ([dict(uid='a', tool='builtin/test@1')] * 2, []),
    ([dict(uid='a', tool='builtin/test@1')], {}),
    ([dict(uid='a', tool='builtin/test@1')], [None]),
    ([dict(uid='a', tool='builtin/test@1')], [dict(name='x', node_uid='b', param='gain')]),
    ([dict(uid='a', tool='builtin/test@1')], [dict(name='x', node_uid='a', param='absent')]),
    ([dict(uid='a', tool='builtin/test@1')], [dict(name='x', node_uid='a', param='gain')] * 2),
])
def test_recipe_rejects_invalid_subchain_or_exposed_without_writes(roots, stack, exposed):
    cat = builtin(roots, PARAMS)
    with pytest.raises(ValueError):
        cat.save_recipe('Bad', stack, exposed)
    assert cat.list_recipes() == []


@pytest.mark.parametrize('raw', ['null', '{}', '{broken', '{"format":2}',
    '{"format":1,"id":"recipe/wrong","name":"Bad","stack":[],"exposed":[]}'])
def test_malformed_recipe_is_not_removed_or_silently_overwritten(roots, raw):
    cat = builtin(roots, PARAMS)
    directory = roots[0] / 'recipes'
    directory.mkdir(parents=True)
    path = directory / 'bad.json'
    path.write_text(raw)
    with pytest.raises(ValueError):
        cat.get_recipe('recipe/bad')
    with pytest.raises(ValueError):
        cat.save_recipe('Bad', [dict(uid='a', tool='builtin/test@1')])
    assert path.read_text() == raw


def test_recipe_updates_are_explicit_and_slug_collisions_preserve_existing(roots):
    cat = builtin(roots, PARAMS)
    stack = [dict(uid='a', tool='builtin/test@1')]
    first = cat.save_recipe('A B', stack)
    with pytest.raises(ValueError, match='collision'):
        cat.save_recipe('A-B', stack)
    assert cat.get_recipe(first['id']) == first
    stack[0]['params'] = {'gain': .5}
    updated = cat.save_recipe('A B', stack)
    assert updated['id'] == first['id']
    assert updated['stack'][0]['params']['gain'] == .5


def test_catalog_runtime_paths_cannot_escape_through_symlinks(roots):
    from studio_core.catalog import Catalog
    data, builtins = roots
    outside = data.parent / 'outside'
    outside.mkdir()
    data.mkdir()
    (data / 'drafts').symlink_to(outside, target_is_directory=True)
    cat = Catalog(data, builtins)
    with pytest.raises(ValueError, match='outside|escape|symlink'):
        cat.create_draft('One', '', [], SHADER)
    assert list(outside.iterdir()) == []


def test_builtin_shader_symlink_cannot_read_outside_builtin_root(roots):
    cat = builtin(roots)
    path = roots[1] / 'test' / 'shader.frag'
    path.unlink()
    secret = roots[0].parent / 'secret'
    secret.write_text(SHADER)
    path.symlink_to(secret)
    with pytest.raises(ValueError, match='outside|escape|symlink'):
        cat.resolve('builtin/test@1')


def test_builtin_manifest_cannot_impersonate_approved_user_tool(roots):
    cat = builtin(roots)
    path = roots[1] / 'test' / 'manifest.json'
    path.write_text(json.dumps({**manifest(), 'id': 'user/test'}))
    with pytest.raises(ValueError, match='identity|namespace'):
        cat.list()


def test_corrupt_draft_does_not_get_silently_replaced_or_deleted(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    cat.create_draft('One', '', [], SHADER)
    path = roots[0] / 'drafts' / 'one' / 'entry.json'
    raw = '{broken'
    path.write_text(raw)
    for action in [lambda: cat.create_draft('One', '', [], SHADER), lambda: cat.approve_draft('user/one'),
                   lambda: cat.delete_draft('user/one'), cat.list]:
        with pytest.raises(ValueError):
            action()
        assert path.read_text() == raw


def _approve_worker(args):
    from studio_core.catalog import Catalog
    try:
        return Catalog(*args).approve_draft('user/one')['ref']
    except ValueError:
        return 'refused'


def test_cross_process_approval_is_single_use_and_keeps_version_one(roots):
    from concurrent.futures import ProcessPoolExecutor
    import multiprocessing
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    cat.create_draft('One', '', [], SHADER)
    cat.record_check('user/one', hashlib.sha256(SHADER.encode()).hexdigest(), {'ok': True})
    with ProcessPoolExecutor(2, mp_context=multiprocessing.get_context('fork')) as pool:
        results = list(pool.map(_approve_worker, [roots, roots]))
    assert sorted(results) == ['refused', 'user/one@1']
    assert [entry['ref'] for entry in cat.list()['tools']] == ['user/one@1']


def test_huge_numeric_parameters_raise_readable_value_errors(roots):
    cat = builtin(roots, PARAMS)
    with pytest.raises(ValueError):
        cat.validate_params('builtin/test@1', {'gain': 10 ** 400})


def test_approved_name_slug_collision_does_not_create_different_tool(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    cat.create_draft('A B', '', [], SHADER)
    cat.record_check('user/a-b', hashlib.sha256(SHADER.encode()).hexdigest(), {'ok': True})
    cat.approve_draft('user/a-b')
    with pytest.raises(ValueError, match='collision'):
        cat.create_draft('A-B', '', [], SHADER)
    assert cat.list()['drafts'] == []


@pytest.mark.parametrize('change', [
    {'provenance': []}, {'provenance': {'author': 3}}, {'license': []},
    {'examples': {}}, {'examples': [None]}, {'examples': [{'params': {'unknown': 1}}]},
])
def test_optional_manifest_metadata_is_validated(roots, change):
    cat = builtin(roots, PARAMS)
    path = roots[1] / 'test' / 'manifest.json'
    path.write_text(json.dumps({**manifest(PARAMS), **change}))
    with pytest.raises(ValueError):
        cat.list()


def _catalog_read_worker(roots, started, finished):
    from studio_core.catalog import Catalog
    started.set()
    Catalog(*roots).list()
    finished.set()


def test_catalog_readers_wait_for_in_flight_mutation_transaction(roots):
    import multiprocessing
    from studio_core.catalog import Catalog
    ctx = multiprocessing.get_context('fork')
    started, finished = ctx.Event(), ctx.Event()
    cat = Catalog(*roots)
    process = ctx.Process(target=_catalog_read_worker, args=(roots, started, finished))
    try:
        with cat._lock():
            process.start()
            assert started.wait(5)
            assert not finished.wait(.1)
        process.join(5)
        assert process.exitcode == 0
        assert finished.is_set()
    finally:
        if process.is_alive():
            process.terminate()
            process.join()


@pytest.mark.parametrize('name', ['switch', 'case', 'default', 'uint', 'samplerCube', 'layout', 'highp', 'precision'])
def test_glsl_reserved_parameter_names_are_rejected(roots, name):
    cat = builtin(roots)
    path = roots[1] / 'test' / 'manifest.json'
    path.write_text(json.dumps(manifest([dict(name=name, type='bool', default=True)])))
    with pytest.raises(ValueError, match='reserved'):
        cat.list()


def test_repository_builtins_match_catalog_and_parameter_contract(roots):
    from studio_core.catalog import Catalog
    builtins = Path(__file__).resolve().parents[1] / 'tools' / 'builtin'
    cat = Catalog(roots[0], builtins)
    entries = cat.list()['tools']
    assert {entry['ref'] for entry in entries} == {
        'builtin/pixelate@1', 'builtin/dither@1', 'builtin/halftone@1', 'builtin/gradient_map@1',
        'builtin/grain@1', 'builtin/chromatic_aberration@1', 'builtin/levels@1'}
    for entry in entries:
        assert cat.resolve(entry['ref']) == entry
        values = cat.validate_params(entry['ref'], {})
        assert set(values) == {p['name'] for p in entry['manifest']['params']}


def test_approval_and_explicit_delete_preserve_unrecognized_sidecar_files(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    cat.create_draft('One', '', [], SHADER)
    sidecar = roots[0] / 'drafts' / 'one' / 'notes.txt'
    sidecar.write_text('keep human notes')
    cat.record_check('user/one', hashlib.sha256(SHADER.encode()).hexdigest(), {'ok': True})
    assert cat.approve_draft('user/one')['ref'] == 'user/one@1'
    assert sidecar.read_text() == 'keep human notes'
    cat.create_draft('One', '', [], SHADER)
    cat.delete_draft('user/one')
    assert sidecar.read_text() == 'keep human notes'


def test_approval_does_not_replace_preexisting_unrecognized_version_directory(roots):
    from studio_core.catalog import Catalog
    cat = Catalog(*roots)
    cat.create_draft('One', '', [], SHADER)
    cat.record_check('user/one', hashlib.sha256(SHADER.encode()).hexdigest(), {'ok': True})
    target = roots[0] / 'tools' / 'one' / '1'
    target.mkdir(parents=True)
    with pytest.raises(ValueError, match='exists|existing|incomplete'):
        cat.approve_draft('user/one')
    assert target.is_dir()
    assert cat.list()['drafts']


@pytest.mark.parametrize('params', [None, [], {'missing': 1}, {'gain': True}, {'gain': '1'},
    {'gain': float('nan')}, {'gain': float('inf')}, {'gain': -0.1}, {'gain': 2.1},
    {'steps': 1.5}, {'steps': True}, {'steps': 0}, {'on': 1}, {'tint': '#fff'},
    {'tint': [1, 0, 0]}, {'mode': 1}, {'mode': 'c'}])
def test_param_values_reject_invalid_types_ranges_and_unknown_fields(roots, params):
    cat = builtin(roots, PARAMS)
    with pytest.raises(ValueError):
        cat.validate_params('builtin/test@1', params)


@pytest.mark.parametrize('definitions', [
    [dict(name='bad-name', type='int', min=0, max=1, default=0)],
    [dict(name='gl_bad', type='bool', default=False)],
    [dict(name='u_time', type='bool', default=False)],
    [dict(name='p_gain', type='bool', default=False)],
    [dict(name='main', type='bool', default=False)],
    [PARAMS[0], PARAMS[0]],
    [dict(name='x', type='vec2', default=[0, 0])],
    [dict(name='x', type='float', min=2, max=1, default=1)],
    [dict(name='x', type='float', min=0, max=1, default=2)],
    [dict(name='x', type='int', min=0.5, max=2, default=1)],
    [dict(name='x', type='enum', options=[], default='a')],
    [dict(name='x', type='enum', options=['a', 'a'], default='a')],
    [dict(name='x', type='bool')], None, {}, [None],
])
def test_manifest_rejects_invalid_parameter_schemas(roots, definitions):
    cat = builtin(roots)
    path = roots[1] / 'test' / 'manifest.json'
    path.write_text(json.dumps({**manifest(), 'params': definitions}))
    with pytest.raises(ValueError):
        cat.resolve('builtin/test@1')
    assert path.exists()


@pytest.mark.parametrize('change', [dict(format=2), dict(format=True), dict(version=0),
    dict(version=True), dict(id='../oops'), dict(kind='html'), dict(shader='../secret'),
    dict(name=3), dict(description=None)])
def test_manifest_errors_preserve_source_files(roots, change):
    cat = builtin(roots)
    path = roots[1] / 'test' / 'manifest.json'
    raw = json.dumps({**manifest(), **change})
    path.write_text(raw)
    with pytest.raises(ValueError):
        cat.list()
    assert path.read_text() == raw


@pytest.mark.parametrize('raw', ['{bad json', 'null', '[]', '{}'])
def test_malformed_manifest_errors_are_readable(roots, raw):
    cat = builtin(roots)
    path = roots[1] / 'test' / 'manifest.json'
    path.write_text(raw)
    with pytest.raises(ValueError, match='manifest'):
        cat.list()
    assert path.read_text() == raw


@pytest.mark.parametrize('shader', [
    'void reset(out int x){x=0;} void main(){for(int i=0;i<8;i++){reset(i);}}',
    'void main(){for(int i=0;i<8;i++){i >>= 1;}}',
    'void main(){for(int i=0;i<8;i++){i <<= 0;}}',
    'void main(){for(int i=0;i<8;i++){float f=frexp(1.,i);}}',
])
def test_loop_counter_cannot_be_reset_through_shift_or_out_arguments(shader):
    from studio_core.catalog import validate_shader
    with pytest.raises(ValueError):
        validate_shader(shader)


@pytest.mark.parametrize('shader', [
    'void main(){while(false){}}', 'void main(){do{}while(false);}',
    'void main(){for(int i=0;i<257;i++){}}',
    'void main(){for(int i=0;i<=256;i++){}}',
    'void main(){for(int i=0;i<N;i++){}}',
    'void main(){for(int i=1;i<8;i++){}}',
    'void main(){for(int i=0;i<8;i--){}}',
    'void main(){for(int i=0;i<8;i++){i=0;}}',
    'void main(){for(int i=0;i<8;i++) i=0;}',
    '#define LOOP while\nvoid main(){}',
    'void main(){whi\\\nle(false){}}',
    'void main(){} /* unterminated',
    'void main(){} //é' + 'é' * 16384,
    '\x00void main(){}',
])
def test_shader_rejects_unsafe_or_ambiguous_forms(shader):
    from studio_core.catalog import validate_shader
    with pytest.raises(ValueError):
        validate_shader(shader)


@pytest.mark.parametrize('body', ['(i)=0;', '++(i);', '((i))++;', '((i)) >>= 1;'])
def test_parenthesized_loop_counter_mutations_are_rejected(body):
    from studio_core.catalog import validate_shader
    with pytest.raises(ValueError):
        validate_shader('void main(){for(int i=0;i<8;i++){' + body + '}}')


def test_loop_body_can_compare_counter_without_mutating_it():
    from studio_core.catalog import validate_shader
    validate_shader('void main(){for(int i=0;i<8;i++){if(i<=4 || i>=6){outColor+=vec4(0.);}}}')


def test_shader_accepts_bounded_loops_and_comments():
    from studio_core.catalog import validate_shader
    validate_shader(SHADER)
    validate_shader('// while do\nvoid main(){for(int i=0;i<256;i++){outColor+=vec4(0.);}}')
    validate_shader('/* while do */ void main(){ for (int j = 0; j <= 255; ++j) {} }')
