"""Read-only P1 client evidence audit; never simulates human UI actions.

Only writes evidence/p1-runtime-verification.json. A pass still needs the user's
explicit confirmation/screenshots of manual creation/approval and native Save as.
P2 agent-call correlation is a separate gate, never inferred here.
"""
import hashlib
import json
import math
from pathlib import Path
import sys

from PIL import Image

REPO = Path(__file__).resolve().parents[1]
ROOT = Path.home() / '.hermes/plugin-data/hermes-design-studio'
BUILD = 'design-studio-p1-20261111-studio-1'
EXPECTED = {'pixelate', 'dither', 'halftone', 'gradient_map', 'grain',
            'chromatic_aberration', 'levels'}


def read(path):
    return json.loads(path.read_text())


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def png(path, sha=None):
    path = Path(path).resolve()
    require(path.is_relative_to(ROOT.resolve()), 'PNG must be in plugin-data')
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    if sha is not None:
        require(digest == sha, 'PNG SHA-256 differs from receipt')
    with Image.open(path) as image:
        require(image.format == 'PNG', 'not PNG')
        image.verify()
    with Image.open(path) as image:
        image.load()
        return {'path': str(path), 'sha256': digest, 'size': list(image.size),
                'bytes': path.stat().st_size, 'pillow_verify_load': True}


def diagnostics():
    d = read(ROOT / 'diagnostics.json')
    require(d.get('build') == BUILD, 'not the P1 client build')
    require(d.get('run_id'), 'missing client run provenance')
    checks = d.get('checks', [])
    tools = {x.get('tool', '').split('/')[-1].split('@')[0] for x in checks}
    require(d.get('pass') is True and len(checks) == len(EXPECTED), 'diagnostics not all pass')
    require(tools == EXPECTED and all(x.get('pass') is True for x in checks),
            'missing/failing builtin diagnostics')
    return {'build': d['build'], 'run_id': d['run_id'], 'tools': sorted(tools),
            'checks': checks, 'path': str(ROOT / 'diagnostics.json')}


def project():
    pointer = read(ROOT / 'current-project.json')
    d = read(ROOT / 'projects' / pointer['id'] / 'project.json')
    require(d['id'] == pointer['id'], 'project identity mismatch')
    require(d.get('source') and d['stack'], 'import and build a stack manually first')
    rows = [json.loads(line) for line in (ROOT / 'commands.jsonl').read_text().splitlines()]
    rows = [r for r in rows if r['project_id'] == d['id']]
    require(rows and all(r['source'] == 'ui' for r in rows),
            'P1 manual project must contain only UI command batches')
    require(any(c['type'] == 'set_source' for r in rows for c in r['commands']),
            'no manual source command')
    require(any(c['type'] == 'add_node' for r in rows for c in r['commands']),
            'no manual operation command')
    manual_tools = []
    for node in d['stack']:
        if not node['tool'].startswith('user/'):
            continue
        slug, version = node['tool'].removeprefix('user/').split('@')
        m = read(ROOT / 'tools' / slug / version / 'manifest.json')
        if m['provenance']['author'] == 'user':
            manual_tools.append({'ref': node['tool'], 'provenance': m['provenance']})
    require(manual_tools, 'apply a manually created and human-approved tool')
    asset = png(ROOT / d['source']['asset'])
    return {'project_id': d['id'], 'revision': d['revision'], 'manual_tools': manual_tools,
            'ui_command_ids': [r['id'] for r in rows], 'source': asset}


def preview():
    r = read(ROOT / 'latest.json')
    require(r.get('build') == BUILD, 'preview from older client build')
    d = read(ROOT / 'projects' / read(ROOT / 'current-project.json')['id'] / 'project.json')
    require((r.get('project_id'), r['revision']) == (d['id'], d['revision']),
            'preview is stale')
    metrics = r.get('metrics', {})
    for key in ('mean_luma', 'std_luma', 'shadow_clipping_pct', 'highlight_clipping_pct',
                'detail_density', 'difference_source'):
        require(type(metrics.get(key)) in (int, float) and math.isfinite(metrics[key]),
                'missing/invalid ' + key)
    require('difference_previous' in metrics and 'nearly_uniform' in metrics and
            metrics.get('dominant_colors'), 'missing frame metrics')
    image = png(r['path'], r['sha256'])
    require(image['size'] == [r['width'], r['height']], 'preview dimensions mismatch')
    return {'image': image, 'metadata': r,
            'summary_payload': json.dumps(r, sort_keys=True, allow_nan=False),
            'note': 'Actual UI frame metadata; not a real agent tool call. P2 verifies that separately.'}


def exports():
    results = []
    for path in (ROOT / 'responses').glob('*.json'):
        r = read(path)
        if r.get('kind') != 'export' or r.get('build') != BUILD or r.get('error'):
            continue
        p = Path(r['path']).resolve()
        require(p.parent == (ROOT / 'exports').resolve(), 'export outside library')
        results.append({'request_id': r['request_id'], 'project_id': r['project_id'],
                        'revision': r['revision'], 'run_id': r['run_id'],
                        'image': png(p, r['sha256'])})
    require(results, 'no real P1 Save to library export')
    return results


def main():
    report = {'scope': 'real client persisted P1 evidence; read-only audit',
              'requires_human_attestation': ['manual creation/approval without agent',
                                             'native Save as dialog and saved local PNG'],
              'checks': {}}
    for name, check in [('diagnostics', diagnostics), ('manual_project', project),
                        ('preview', preview), ('exports', exports)]:
        try:
            report['checks'][name] = {'pass': True, 'evidence': check()}
        except (OSError, ValueError, KeyError, TypeError, AssertionError) as exc:
            report['checks'][name] = {'pass': False, 'error': str(exc)}
    report['pass'] = all(v['pass'] for v in report['checks'].values())
    output = REPO / 'evidence/p1-runtime-verification.json'
    output.write_text(json.dumps(report, indent=2, allow_nan=False) + '\n')
    print(json.dumps(report, indent=2, allow_nan=False))
    return 0 if report['pass'] else 1


if __name__ == '__main__':
    sys.exit(main())
