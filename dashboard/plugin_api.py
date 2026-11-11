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
_spec = importlib.util.spec_from_file_location(
    '_design_studio_bridge', Path(__file__).resolve().parents[1] / 'studio_core' / 'bridge.py')
assert _spec is not None and _spec.loader is not None
_bridge = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_bridge)
Store = _bridge.Store
router = APIRouter()


def get_store():
    from plugins.plugin_storage import plugin_data_dir
    return Store(plugin_data_dir('hermes-design-studio'))


async def _call(method, *args, **kwargs):
    try:
        return await asyncio.to_thread(method, *args, **kwargs)
    except (ValueError, TypeError, OSError) as exc:
        raise HTTPException(400, str(exc)) from exc


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
    return await _call(get_store().state)


@router.post('/render/request')
async def render_request(request: Request):
    payload = await _json(request)
    kind = payload.pop('kind', None)
    return await _call(get_store().request, kind, **payload)


@router.get('/render/requests')
async def render_requests():
    return {'requests': (await _call(get_store().state))['pending']}


@router.post('/render/response')
async def render_response(request: Request, id: str):
    return await _call(get_store().respond, id, await _file(request, 64*1024*1024), _meta(request))


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
