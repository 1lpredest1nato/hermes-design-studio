from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_bundled_usage_skill_frontmatter_and_safety_contract():
    path = ROOT / 'skills' / 'usage' / 'SKILL.md'
    assert path.is_file(), 'P2 must ship the namespaced usage skill'
    text = path.read_text()
    assert text.startswith('---\n')
    front, body = text[4:].split('\n---\n', 1)
    meta = yaml.safe_load(front)
    assert meta['name'] == 'usage'
    assert len(meta['description']) <= 60 and meta['description'].endswith('.')
    assert meta['author'].startswith('1lpredest1nato')
    assert meta['license'] == 'MIT' and meta['platforms']
    for phrase in ('## When to Use', '## Prerequisites', '## Procedure',
                   '## Pitfalls', '## Verification', 'project_id', 'base_revision',
                   'u_time', 'text_summary', '409', 'human', 'stale',
                   '32 KiB', '256', 'vision_analyze'):
        assert phrase in body, phrase
    assert '/home/' not in text
    assert 'HTTP' in body and 'approve' in body
    assert len(text) < 15000
