"""Final artifact readback and structured handoff, limited to this worktree."""
from pathlib import Path
import ast
import datetime
import hashlib
import json
import os
import subprocess

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'evidence'
TARGET = Path('/home/destino/projects/hermes-design-studio/evidence/tmp-p3-final-home/plugins/hermes-design-studio')
readback = json.loads((OUT / 'p3-close-payload-readback.json').read_text())
validation = json.loads((OUT / 'p3-close-validate.json').read_text())
audit = json.loads((OUT / 'p3-close-audit.json').read_text())
provenance = json.loads((OUT / 'p3-close-provenance.json').read_text())
rows = []
for row in readback['payload_files']:
    data = (TARGET / row['path']).read_bytes()
    sha = hashlib.sha256(data).hexdigest()
    rows.append({'path': row['path'], 'sha256': sha, 'matches_source': sha == row['source_sha256']})
assert len(rows) == 43 and all(row['matches_source'] for row in rows)
assert validation['exit_code'] == 0 and validation['validation_passed_text']
assert validation['isolated_home_metadata_unchanged'] and not validation['timed_out']
assert audit['focused_tests_exit_code'] == 0
assert audit['prior_acceptance_records']['p1']['diagnostics_cases'] == 25
assert all(row['recorded_pass'] for row in audit['prior_acceptance_records'].values())
assert not audit['executable_changes_since_baseline']
for path in OUT.glob('p3-close-*.py'):
    ast.parse(path.read_text(), filename=str(path))
for row in provenance['parent_evidence_copies']:
    assert hashlib.sha256((ROOT / row['copy']).read_bytes()).hexdigest() == row['sha256']
record = {'checked_utc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'target': str(TARGET), 'source_commit': readback['source_commit'],
          'post_validation_payload_count': len(rows), 'post_validation_mismatches': [], 'files': rows,
          'parent_log_copy_hashes_match': True, 'evidence_helpers_ast_parse': True}
(OUT / 'p3-close-final-integrity.json').write_text(json.dumps(record, indent=2) + '\n')
report = {
    'schema_version': 1,
    'status': 'verification_handoff_not_whole_task_completion',
    'summary_ru': 'Exact isolated installed clone прошёл native plugins validate через default working runtime; package readback совпал. Общий P3/проект не закрыт: нужны privacy correction, интеграция evidence и дальнейшие parent/human gates.',
    'worktree': str(ROOT), 'branch': 'verify/p3-close',
    'source_commit': readback['source_commit'],
    'human_report': 'P3-CLOSE-REPORT.md',
    'validation': validation,
    'install_readback': {'target': str(TARGET), 'clone_head': readback['clone_head'],
                        'metadata': readback['install_metadata'], 'payload_count': len(rows),
                        'mismatches': [], 'optional_package_json_exists': False,
                        'post_validation_readback': 'evidence/p3-close-final-integrity.json'},
    'prior_install': {'ordinary_install_exit_code': 1, 'ordinary_scan_verdict': 'CAUTION',
                      'ordinary_scan_decision': 'BLOCKED', 'forced_install_exit_code': 0,
                      'force_scope': 'Reviewed self-authored local exact Git commit only; disclosed README:31-36.',
                      'enabled': False, 'plugin_dependencies_requested': False,
                      'original_install_log_reports_hermes_runtime_preparation': True,
                      'new_install_or_provision_by_this_worker': False,
                      'parent_evidence': provenance['parent_evidence_copies']},
    'checks': [
        {'id': 'exact_clone_validation', 'status': 'pass_with_caution', 'evidence': 'evidence/p3-close-validate.json'},
        {'id': '43_payload_sha256_readback', 'status': 'pass', 'evidence': 'evidence/p3-close-payload-readback.json'},
        {'id': 'isolated_home_unchanged', 'status': 'pass_metadata_snapshot', 'entries': 714,
         'scope': 'All path modes/sizes/mtime_ns before and after validate; excludes atime. No credential/config contents read.'},
        {'id': 'manifest_skill_focused_tests', 'status': 'pass', 'tests': 3, 'exit_code': 0,
         'evidence': 'evidence/p3-close-focused-tests.stdout.txt'},
        {'id': 'catalog_preparation', 'status': 'pass_as_explicit_draft_only',
         'schema_source': 'evidence/p3-close-catalog-schema-source.md',
         'admission_status': 'not_ready_missing_sha_unverified_public_repo'},
        {'id': 'readme_submission_disclosure_links', 'status': 'pass_except_screenshot_privacy_and_parent_evidence_integration',
         'broken_explicit_local_markdown_links': audit['broken_markdown_links']},
        {'id': 'prior_P0_P1_P2_acceptance_records', 'status': 'inspected_in_full_read_only',
         'evidence': 'evidence/p3-close-audit.json', 'live_project_commands': False,
         'new_live_history_or_png_verification': False},
        {'id': 'runtime_unchanged_since_355plus55', 'status': 'pass', 'baseline': audit['code_baseline'],
         'runtime_changed_paths': audit['executable_changes_since_baseline'], 'full_suite_rerun': False}
    ],
    'submission_counts': audit['submission'],
    'prior_acceptance_records': audit['prior_acceptance_records'],
    'remote_reference_reads': audit['remote_reference_reads'],
    'remaining_gates': [
        {'id': 'screenshot_privacy', 'owner': 'parent/author', 'blocks': 'publication_readiness',
         'refs': ['README.md:119', 'docs/architecture-and-verification.md:100', 'docs/screenshots/studio-p1.png'],
         'finding_ru': 'При реальном просмотре screenshot внизу видны username и абсолютный Gateway path, вопреки заявлению об удалённых server paths. Credentials/приватных чатов не видно. Нужны crop/redaction либо явное согласование публикации пути и исправление подписи.',
         'image_sha256': '6cbad4c83d2b8a18caf5ad37c9d2c7f62a8f71fb5fc8cc96adf9f002a51d0619'},
        {'id': 'delivery_evidence_integration', 'owner': 'parent', 'blocks': 'tracked_delivery_completeness',
         'refs': ['README.md:5', 'README.md:113', 'SUBMISSION.md:41', 'SUBMISSION.md:53', 'BUILD-LOG.md'],
         'finding_ru': 'evidence/p3-final-install.json существует uncommitted у родителя, но отсутствует в этом delivery tree; prefixed неизменённая копия сохранена. Включить final evidence/logs, обновить BUILD-LOG/pending checklist, скопировать SUBMISSION в orchestration directory. Не подменять исторический tested SHA новым reports-only commit.'},
        {'id': 'fully_isolated_runtime_validation', 'owner': 'parent', 'status': 'prior_timeout_not_retried',
         'blocks': 'only_if_separate_interpreter_runtime_validation_is_required',
         'finding_ru': 'Успешная проверка использовала default working runtime для exact temp-installed target. Прежний CLI запуск с temp HERMES_HOME timeout не объявляется PASS; rebuild/provisioning не делались.',
         'refs': ['evidence/p3-close-parent-p3-final-install.json:18', 'evidence/p3-close-parent-p3-clean-validate.txt']},
        {'id': 'P4_and_human_submission', 'owner': 'authorized_parent/author', 'status': 'not_performed',
         'finding_ru': 'Нужны отдельное разрешение, public repo/remote final SHA/catalog PR/CI/review, реальное видео с измеренной длительностью, post и form receipt. Нет вымышленных URL или заявлений о публикации.'}
    ],
    'constraints': {'source_feature_edits': False, 'main_or_deployed_copy_writes': False,
                    'config_changes': False, 'global_scan_bypass': False, 'delegation': False,
                    'desktop_gateway_restart': False, 'publishing': False, 'shared_environment_exports': False,
                    'whole_task_marked_complete': False},
    'artifact_refs': sorted(str(p.relative_to(ROOT)) for p in OUT.glob('p3-close-*')),
    'checked_utc': record['checked_utc']
}
(ROOT / 'P3-CLOSE-REPORT.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps({'report': str(ROOT / 'P3-CLOSE-REPORT.json'), 'source_commit': readback['source_commit'],
                  'post_validation_payload_count': len(rows), 'mismatches': [],
                  'p1_diagnostics_cases': audit['prior_acceptance_records']['p1']['diagnostics_cases'],
                  'parent_log_copies_verified': len(provenance['parent_evidence_copies']),
                  'remaining_gates': [row['id'] for row in report['remaining_gates']]}, ensure_ascii=False, indent=2))
