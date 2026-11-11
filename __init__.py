"""Thin Hermes tool adapter. Import and registration do not touch plugin-data."""
import base64
import json

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


def get_store():
    from plugins.plugin_storage import plugin_data_dir
    return Application(plugin_data_dir(PLUGIN_ID)).bridge


def preview(args, **kwargs):
    try:
        args = args or {}
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


def register(ctx):
    ctx.register_tool(name=TOOL_NAME, toolset='design_studio', schema=SCHEMA, handler=preview)
