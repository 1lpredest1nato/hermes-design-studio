"""Thin Hermes tool adapter. Import and registration do not touch plugin-data."""
import base64
import json
import re

import importlib
import hashlib
import sys
import types
from pathlib import Path

_core_path = Path(__file__).resolve().parent / 'studio_core'
_core_name = '_design_studio_core_' + hashlib.sha256(str(_core_path).encode()).hexdigest()[:12]
if _core_name not in sys.modules:
    _core_package = types.ModuleType(_core_name)
    _core_package.__path__ = [str(_core_path)]
    sys.modules[_core_name] = _core_package
Application = importlib.import_module(_core_name + '.application').Application
Conflict = importlib.import_module(_core_name + '.projects').Conflict

PLUGIN_ID = 'hermes-design-studio'
TOOL_NAME = 'design_studio_preview'
SCHEMA = {
    'name': TOOL_NAME,
    'description': 'Render the current Design Studio revision as a PNG preview with image metrics. Requires an enabled Design Studio renderer in an open Hermes Desktop window. Waits at most 10 seconds, then returns a cached preview labeled stale when available. Inspect the preview before making visual claims; text_summary and a server file path support models without vision.',
    'parameters': {'type': 'object', 'properties': {
        'max_size': {'type': 'integer', 'minimum': 1, 'maximum': 1600,
                     'description': 'Longest preview side in pixels (default 1600).'}},
        'additionalProperties': False},
}


def get_application():
    from plugins.plugin_storage import plugin_data_dir
    return Application(plugin_data_dir(PLUGIN_ID))


def _args(args, required=(), optional=()):
    if not isinstance(args, dict):
        raise ValueError('arguments must be an object')
    if set(required) - args.keys() or args.keys() - set(required) - set(optional):
        raise ValueError('missing or unsupported arguments')
    return args


def _response(call):
    try:
        result = call()
        return result if isinstance(result, dict) and result.get('_multimodal') is True else json.dumps(result, allow_nan=False)
    except Conflict as exc:
        return json.dumps({'error': str(exc), 'current': exc.document,
                           'document': exc.document, 'status': 409})
    except (ValueError, OSError, TimeoutError) as exc:
        return json.dumps({'error': str(exc), 'status': 400})


def catalog(args, **kwargs):
    def run():
        _args(args, optional=('query',))
        query = args.get('query', '')
        if not isinstance(query, str):
            raise ValueError('query must be text')
        entries = get_application().catalog.list()
        return {key: [entry for entry in values
                      if query.casefold() in json.dumps(entry, ensure_ascii=False).casefold()]
                for key, values in entries.items()}
    return _response(run)


def project(args, **kwargs):
    def run():
        _args(args, required=('action',), optional=('path',))
        action = args['action']
        if action not in ('get', 'new', 'import_image'):
            raise ValueError('action must be get, new or import_image')
        if action == 'import_image':
            if not isinstance(args.get('path'), str) or not args['path'].strip() or '\x00' in args['path']:
                raise ValueError('path must be explicit nonempty server path text')
        elif 'path' in args:
            raise ValueError('path is only valid for import_image')
        app = get_application()
        if action == 'import_image':
            snapshot = app.projects.get()
            importer = importlib.import_module(_core_name + '.import_image').import_image
            asset = importer(app.root, args['path'])
            return app.projects.apply(snapshot['revision'], [
                {'type': 'set_source', 'source': {key: asset[key] for key in ('asset', 'w', 'h')}}],
                source='agent', project_id=snapshot['id'])
        return app.projects.get() if action == 'get' else app.projects.new()
    return _response(run)


def _snapshot_args(args):
    ident = args['project_id']
    if not isinstance(ident, str) or not re.fullmatch(r'[a-f0-9]{32}', ident):
        raise ValueError('project_id must be an explicit 32-character lowercase hex id')
    if type(args['base_revision']) is not int or args['base_revision'] < 0:
        raise ValueError('base_revision must be a nonnegative integer')


def apply(args, **kwargs):
    def run():
        _args(args, required=('project_id', 'base_revision', 'commands'))
        _snapshot_args(args)
        if not isinstance(args['commands'], list) or not args['commands'] or any(not isinstance(c, dict) for c in args['commands']):
            raise ValueError('commands must be a nonempty array of objects')
        return get_application().projects.apply(args['base_revision'], args['commands'],
                                               source='agent', project_id=args['project_id'])
    return _response(run)


def _image_result(store, result):
    summary = json.dumps(result, allow_nan=False, sort_keys=True) + '\nIf useful, call vision_analyze with this server PNG path; an auxiliary vision model may be available.'
    png = store._bytes(result['path'], 64*1024*1024)
    return {**result, '_multimodal': True, 'content': [
        {'type': 'text', 'text': summary},
        {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')}}],
        'text_summary': summary}


def create_tool(args, **kwargs):
    def run():
        _args(args, required=('name', 'description', 'params', 'shader'))
        if any(not isinstance(args[key], str) for key in ('name', 'description', 'shader')):
            raise ValueError('name, description and shader must be text')
        if not isinstance(args['params'], list) or any(not isinstance(p, dict) for p in args['params']):
            raise ValueError('params must be an array of objects')
        app = get_application()
        entry = app.catalog.create_draft(**args, author='agent')
        ident = entry['manifest']['id']
        request = app.check_draft(ident, fixture=True,
                                  expected_shader_sha=entry['expected_shader_sha'],
                                  expected_manifest_sha=entry['expected_manifest_sha'])
        result = dict(draft_id=ident, ref=entry['ref'], needs_human_approval=True,
                      request_id=request['request_id'])
        receipt = app.bridge.wait(request['request_id'], timeout=10)
        if receipt is None:
            return {**result, 'pending': True, 'compilation': 'pending',
                    'hint': 'Draft saved; open Hermes Desktop with Design Studio enabled to finish the fixture check.'}
        if 'error' in receipt:
            return {**result, 'compilation': 'failed', 'error': receipt['error'], 'check': receipt}
        if not receipt.get('path'):
            raise ValueError('renderer check receipt has no PNG path')
        return _image_result(app.bridge, {**receipt, **result, 'compilation': 'passed',
                                          'check': receipt, 'preview': receipt})
    return _response(run)


def recipe(args, **kwargs):
    def run():
        _args(args, required=('action',), optional=('name', 'stack', 'exposed', 'id', 'project_id', 'base_revision'))
        action = args['action']
        if action == 'save':
            _args(args, required=('action', 'name'), optional=('stack', 'exposed'))
            if not isinstance(args['name'], str) or not args['name'].strip():
                raise ValueError('name must be nonempty text')
            for key in ('stack', 'exposed'):
                if key in args and (not isinstance(args[key], list) or any(not isinstance(item, dict) for item in args[key])):
                    raise ValueError(key + ' must be an array of objects')
        elif action == 'apply':
            _args(args, required=('action', 'id', 'project_id', 'base_revision'))
            _snapshot_args(args)
            if not isinstance(args['id'], str):
                raise ValueError('recipe id must be text')
        elif action == 'list':
            _args(args, required=('action',))
        else:
            raise ValueError('action must be save, apply or list')
        app = get_application()
        if action == 'list':
            return app.catalog.list_recipes()
        if action == 'save':
            stack = args['stack'] if 'stack' in args else app.projects.get()['stack']
            return app.catalog.save_recipe(args['name'], stack, args.get('exposed'))
        saved = app.catalog.get_recipe(args['id'])
        return app.projects.apply(args['base_revision'], [{'type': 'apply_recipe', 'stack': saved['stack']}],
                                  source='agent', project_id=args['project_id'])
    return _response(run)


def export(args, **kwargs):
    def run():
        _args(args, required=('format',))
        if args['format'] != 'png':
            raise ValueError('format must be png')
        app = get_application()
        request = app.bridge.request('export', format='png')
        receipt = app.bridge.wait(request['request_id'], timeout=10)
        if receipt is None:
            return {'pending': True, 'request_id': request['request_id'],
                    'hint': 'Export requested; no renderer receipt yet. Open Hermes Desktop with Design Studio enabled.'}
        return receipt
    return _response(run)


def get_store():
    from plugins.plugin_storage import plugin_data_dir
    return Application(plugin_data_dir(PLUGIN_ID)).bridge


def preview(args, **kwargs):
    try:
        _args(args, optional=('max_size',))
        max_size = args.get('max_size', 1600)
        if type(max_size) is not int or not 1 <= max_size <= 1600:
            raise ValueError('max_size must be an integer from 1 to 1600')
        store = get_store()
        # Files + polling are authoritative; events are only a latency hint.
        result = store.preview(max_size=max_size)
        summary = json.dumps(result, allow_nan=False, sort_keys=True) + '\nIf useful, call vision_analyze with this server PNG path; an auxiliary vision model may be available.'
        png = store._bytes(result['path'], 64*1024*1024)
        return {**result, '_multimodal': True, 'content': [
            {'type': 'text', 'text': summary},
            {'type': 'image_url', 'image_url': {'url': 'data:image/png;base64,' + base64.b64encode(png).decode('ascii')}}],
            'text_summary': summary}
    except (ValueError, OSError, TimeoutError) as exc:
        return json.dumps({'error': str(exc), 'hint': 'Open Hermes Desktop and enable Design Studio. A proactively cached preview avoids host wait/deadlock issues.'})


def _schema(name, description, properties, required=()):
    return {'name': 'design_studio_' + name, 'description': description,
            'parameters': {'type': 'object', 'properties': properties,
                           'required': list(required), 'additionalProperties': False}}


_IDENTITY = {'project_id': {'type': 'string', 'pattern': '^[a-f0-9]{32}$'},
             'base_revision': {'type': 'integer', 'minimum': 0}}
_SCHEMAS = [
    _schema('catalog', 'List validated built-in tools, approved tools, drafts and recipes with version refs and parameter definitions. Optional case-insensitive text search.',
            {'query': {'type': 'string'}}),
    _schema('project', 'Read or create the current project, or import an explicit image path on the gateway server. Import snapshots identity/revision before reading and fails on concurrent changes; never silently retries.',
            {'action': {'type': 'string', 'enum': ['get', 'new', 'import_image']},
             'path': {'type': 'string', 'minLength': 1}}, ('action',)),
    _schema('apply', 'Apply one atomic core command batch as agent. Explicit project_id and base_revision are mandatory; 409 includes current document. Re-read and decide; never blindly retry. Commands: add_node, remove_node, move_node, set_params, set_node, set_source, apply_recipe, set_seed. Only approved version refs may be added.',
            {**_IDENTITY, 'commands': {'type': 'array', 'minItems': 1, 'items': {'type': 'object'}}},
            ('project_id', 'base_revision', 'commands')),
    SCHEMA,
    _schema('create_tool', 'Save an agent-authored shader draft and request a fixture compilation check (wait <=10 seconds). GLSL ES 3.00: write functions/main only; provided u_input, u_resolution, u_time=0, u_seed, v_uv, outColor; params become p_<name>. No while/do/preprocessor; literal for bounds <=256, shader <=32KiB. Params types float/int/bool/color/enum, with default and numeric min/max or enum options. Returns PNG+metrics only with real renderer receipt, otherwise pending/error. Human approval in UI is required; this never approves or adds a node. Inspect preview before visual claims.',
            {'name': {'type': 'string', 'minLength': 1}, 'description': {'type': 'string'},
             'params': {'type': 'array', 'items': {'type': 'object'}},
             'shader': {'type': 'string'}}, ('name', 'description', 'params', 'shader')),
    _schema('recipe', 'Save a validated frozen-reference subchain (default current stack), list recipes, or apply via core apply_recipe. Apply requires id/project_id/base_revision. Exposed descriptors are name/node_uid/param, not executable logic.',
            {'action': {'type': 'string', 'enum': ['save', 'apply', 'list']},
             'name': {'type': 'string', 'minLength': 1}, 'stack': {'type': 'array', 'items': {'type': 'object'}},
             'exposed': {'type': 'array', 'items': {'type': 'object', 'properties': {
                 'name': {'type': 'string'}, 'node_uid': {'type': 'string'}, 'param': {'type': 'string'}},
                 'required': ['name', 'node_uid', 'param'], 'additionalProperties': False}},
             'id': {'type': 'string'}, **_IDENTITY}, ('action',)),
    _schema('export', 'Request full-resolution PNG export into plugin-data exports/. Wait <=10 seconds; returns actual export receipt path, dimensions and sha256, or honest pending/error. Never substitutes cached preview.',
            {'format': {'type': 'string', 'enum': ['png']}}, ('format',)),
]


def register(ctx):
    for schema, handler in zip(_SCHEMAS, (catalog, project, apply, preview, create_tool, recipe, export)):
        ctx.register_tool(name=schema['name'], toolset='design_studio', schema=schema, handler=handler)
    ctx.register_skill('usage', Path(__file__).parent / 'skills' / 'usage' / 'SKILL.md')
