"""Hermes HTTP adapter; all durable state lives in the filesystem bridge.

Multipart field: file. Render/cache metadata: URL query meta=<JSON>.
Assets are read with GET /assets/<full-sha256>.png.
"""
import asyncio
from email.parser import BytesParser
from email.policy import default
import importlib.util
import json
from pathlib import Path
import re

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

# Hermes loads dashboard APIs standalone, without a parent Python package.
# Give relative core imports an isolated package without changing sys.path.
import sys
import types
_CORE_NAME = '_hermes_design_studio_core'
if _CORE_NAME not in sys.modules:
    _package = types.ModuleType(_CORE_NAME)
    _package.__path__ = [str(Path(__file__).resolve().parents[1] / 'studio_core')]
    sys.modules[_CORE_NAME] = _package
_core = importlib.import_module(_CORE_NAME + '.application')
Application = _core.Application
Store = importlib.import_module(_CORE_NAME + '.bridge').Store
Conflict = importlib.import_module(_CORE_NAME + '.projects').Conflict
router = APIRouter()


def get_store():
    from plugins.plugin_storage import plugin_data_dir
    return Application(plugin_data_dir('hermes-design-studio')).bridge


def get_application():
    return Application(get_store().root)


async def _call(method, *args, **kwargs):
    try:
        return await asyncio.to_thread(method, *args, **kwargs)
    except Conflict as exc:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=409, content={'error': str(exc), 'document': exc.document})
    except (ValueError, TypeError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


async def _mutate(method, *args, **kwargs):
    result = await _call(method, *args, **kwargs)
    if isinstance(result, dict) and isinstance(result.get('document'), dict):
        try:
            from hermes_cli.plugin_events import broadcast_plugin_event
            await asyncio.to_thread(broadcast_plugin_event, 'hermes-design-studio',
                                    'doc.changed', result['document'])
        except Exception:
            pass  # Durable commands succeeded; polling remains authoritative.
    return result


async def _body(request, limit):
    body = bytearray()
    async for block in request.stream():
        body.extend(block)
        if len(body) > limit:
            raise HTTPException(413, 'request body too large')
    return bytes(body)


async def _json(request):
    try:
        value = json.loads(await _body(request, 2*1024*1024))
        if not isinstance(value, dict):
            raise ValueError('expected JSON object')
        json.dumps(value, allow_nan=False)
        return value
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


def _meta(request):
    try:
        raw = request.query_params.get('meta', '{}')
        if len(raw.encode()) > 256*1024:
            raise ValueError('metadata too large')
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise ValueError('metadata must be object')
        json.dumps(value, allow_nan=False)
        return value
    except (ValueError, TypeError) as exc:
        raise HTTPException(400, str(exc)) from exc


async def _file(request, limit):
    content_type = request.headers.get('content-type', '')
    if not content_type.startswith('multipart/form-data;'):
        raise HTTPException(400, 'expected multipart form field file')
    body = await _body(request, limit + 64*1024)
    message = BytesParser(policy=default).parsebytes(
        b'Content-Type: ' + content_type.encode('ascii') + b'\r\nMIME-Version: 1.0\r\n\r\n' + body)
    files = [part.get_payload(decode=True) for part in message.iter_parts()
             if part.get_param('name', header='content-disposition') == 'file']
    if len(files) != 1 or files[0] is None:
        raise HTTPException(400, 'exactly one multipart file required')
    if len(files[0]) > limit:
        raise HTTPException(413, 'file too large')
    return files[0]


@router.get('/state')
async def state():
    # Preserve the injectable P0 Store seam as well as the full P1 catalog.
    store = get_store()
    return {**(await _call(store.state)),
            'catalog': await _call(Application(store.root).catalog.list)}


@router.post('/project/new')
async def project_new():
    def create():
        return {'document': get_application().projects.new()}
    return await _mutate(create)


@router.post('/commands')
async def commands(request: Request):
    payload = await _json(request)
    return await _mutate(get_application().projects.apply, payload.get('base_revision'),
                       payload.get('commands'), source='ui', gesture_id=payload.get('gesture_id'),
                       project_id=payload.get('project_id'))


@router.post('/history/undo')
async def history_undo(request: Request):
    payload = await _json(request)
    return await _mutate(get_application().projects.undo, payload.get('base_revision'), source='ui',
                       project_id=payload.get('project_id'))


@router.post('/history/redo')
async def history_redo(request: Request):
    payload = await _json(request)
    return await _mutate(get_application().projects.redo, payload.get('base_revision'), source='ui',
                       project_id=payload.get('project_id'))


@router.post('/diagnostics')
async def diagnostics_post(request: Request):
    return await _call(get_application().diagnostics, await _json(request))


@router.get('/diagnostics')
async def diagnostics_get():
    return await _call(get_application().diagnostics)


@router.get('/catalog')
async def catalog_get():
    return await _call(get_application().catalog.list)


@router.post('/drafts')
async def drafts_create(request: Request):
    payload = await _json(request)
    return await _call(get_application().catalog.create_draft, payload.get('name'),
                       payload.get('description', ''), payload.get('params'), payload.get('shader'), author='user')


def _expected_snapshot(payload):
    result = {}
    for key in ('expected_shader_sha', 'expected_manifest_sha'):
        value = payload.get(key)
        if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
            raise HTTPException(status_code=400, detail=f'{key} requires a backend snapshot SHA-256')
        result[key] = value
    return result


@router.post('/drafts/check')
async def drafts_check(request: Request):
    payload = await _json(request)
    return await _call(get_application().check_draft, payload.get('id'),
                       fixture=payload.get('fixture', False), params=payload.get('params'),
                       **_expected_snapshot(payload))


@router.post('/drafts/approve')
async def drafts_approve(request: Request):
    # Human-facing UI route only; no corresponding agent approval tool.
    payload = await _json(request)
    return await _call(get_application().catalog.approve_draft, payload.get('id'), **_expected_snapshot(payload))


@router.delete('/drafts')
async def drafts_delete(id: str):
    return await _call(get_application().catalog.delete_draft, id)


@router.post('/recipes')
async def recipes_save(request: Request):
    payload = await _json(request)
    return await _call(get_application().catalog.save_recipe, payload.get('name'),
                       payload.get('stack'), payload.get('exposed', []))


@router.get('/recipes')
async def recipes_get():
    return {'recipes': await _call(get_application().catalog.list_recipes)}


@router.post('/recipes/apply')
async def recipes_apply(request: Request):
    payload = await _json(request)
    app = get_application()
    def apply():
        recipe = app.catalog.get_recipe(payload.get('id'))
        return app.projects.apply(payload.get('base_revision'),
                                  [{'type': 'apply_recipe', 'stack': recipe['stack']}], source='ui',
                                  project_id=payload.get('project_id'))
    return await _mutate(apply)


@router.get('/render/result')
async def render_result(id: str):
    return await _call(get_application().render_result, id)


@router.post('/render/request')
async def render_request(request: Request):
    payload = await _json(request)
    kind = payload.pop('kind', None)
    if kind == 'check':
        raise HTTPException(400, 'use /drafts/check for a backend-owned compile snapshot')
    return await _call(get_store().request, kind, **payload)


@router.get('/render/requests')
async def render_requests():
    return {'requests': (await _call(get_store().state))['pending']}


@router.post('/render/response')
async def render_response(request: Request, id: str):
    return await _call(get_application().respond, id, await _file(request, 64*1024*1024), _meta(request))


@router.post('/render/error')
async def render_error(request: Request, id: str):
    payload = await _json(request)
    return await _call(get_application().fail, id, payload.get('error'))


@router.post('/preview/cache')
async def preview_cache(request: Request, revision: int):
    return await _call(get_store().cache_preview, await _file(request, 64*1024*1024), revision, _meta(request))


@router.post('/report')
async def report_post(request: Request):
    return await _call(get_store().report, await _json(request))


@router.get('/report')
async def report_get():
    return await _call(get_store().report)


@router.post('/assets/upload')
async def assets_upload(request: Request, id: str, index: int, total: int, sha256: str):
    return await _call(get_store().upload_chunk, id, index, total, sha256, await _file(request, 4*1024*1024))


@router.get('/assets/read')
async def assets_read(sha: str, offset: int = 0, length: int = 1048576):
    return await _call(get_store().read_asset, sha, offset, length)


@router.get('/assets/{sha}.png')
async def asset_get(sha: str):
    if not re.fullmatch('[a-f0-9]{64}', sha):
        raise HTTPException(400, 'invalid asset hash')
    store = get_store()
    path = store.root / 'assets' / (sha + '.png')
    if not path.exists():
        raise HTTPException(404, 'asset not found')
    data = await _call(store._bytes, path, 1024*1024*1024)
    return Response(data, media_type='image/png')
