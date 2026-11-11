# P3 — заключительная независимая проверка для родителя

Статус: **проверка точного установленного артефакта PASS; общий проект/P3 не объявляется завершённым**. Родитель интегрирует evidence, закрывает перечисленные ниже gates и обновляет BUILD-LOG/SUBMISSION. Публикация не выполнялась и не разрешается этим отчётом.

## Точная область

- Рабочее дерево: `/home/destino/projects/hermes-design-plugin/worktrees/p3-close`, ветка `verify/p3-close`.
- Проверенный исходный commit: `610f92e7c8e1a697b909de22c357856b0ed191fc`.
- Существующий установленный clone: `/home/destino/projects/hermes-design-studio/evidence/tmp-p3-final-home/plugins/hermes-design-studio`.
- Исходный BUILD-BRIEF прочитан целиком: `/home/destino/projects/hermes-design-plugin/BUILD-BRIEF.md`, особенно §6/P3 и §9.
- Только новые файлы отчётов/evidence в этом worktree. Ни main, ни deployed dev-копия, ни конфигурация/другие профили, ни Desktop/gateway, ни пользовательский проект не изменялись нашими командами. Нет merge/push/PR, делегации, глобального отключения сканера или provisioning. Переменные окружения для CLI задавались только дочернему `subprocess.run`, без shell export.

## Что реально выполнено

### 1. Exact-clone validation — PASS с CAUTION

Настоящая команда: `<существующий native Python> -m hermes_cli.main plugins validate /home/destino/projects/hermes-design-studio/evidence/tmp-p3-final-home/plugins/hermes-design-studio`.

Дочерний процесс: `HERMES_HOME=/home/destino/.hermes`, `HERMES_DISABLE_LAZY_INSTALLS=1`, `PYTHONDONTWRITEBYTECODE=1`, `GIT_OPTIONAL_LOCKS=0`. Рабочий runtime по умолчанию, **не** bootstrap интерпретатора временного home.

- Начало: `2026-11-11T20:45:23.948703+00:00`; длительность `62.75561767099862 s`.
- **Exit 0, `Validation passed.`**, без timeout. Сохранён полный stdout и отдельный stderr (пуст).
- Manifest, SemVer-выражение `>=0.22.5`, loadability, isolated register probe, семь declared tools, отсутствие конфликтов/core overrides и Desktop SDK surface прошли.
- **Security scan: caution**, не SAFE. Предупреждение: `exec_string (p1-static-security.json:8)`. Это буквальная запись результата старого security-аудита; `evidence/p1-static-security.json:5–9` связывает её с `RegExp.exec` на фиксированном asset regex. Наличие CAUTION не скрыто и не превращается в полную гарантию безопасности.
- Полные доказательства: `evidence/p3-close-validate.json`, `evidence/p3-close-validate.stdout.txt`, `evidence/p3-close-validate.stderr.txt`; воспроизводящий скрипт `evidence/p3-close-validate.py`.

Это закрывает именно валидацию **точного clone**, установленного во временный home. Это не успешный повтор запуска CLI с временным `HERMES_HOME`. Прежний timeout такого запуска остаётся фактом: `evidence/p3-close-parent-p3-final-install.json:18`, `evidence/p3-close-parent-p3-clean-validate.txt`. Не предпринималось исправление Hermes или provisioning ради этой проверки.

### 2. Независимый package/source readback — PASS

- `git rev-parse HEAD` в clone = `610f92e7c8e1a697b909de22c357856b0ed191fc`.
- Реальная `.install-metadata.json`: `pinned:true`, та же revision, source `file:///home/destino/projects/hermes-design-studio`.
- **43 существующих payload-файла**, каждый прочитан и побайтово/по SHA-256 сравнен с `git show 610f92e…:<path>`; **0 несовпадений**. Включены manifest, adapter, оба core, Desktop bundle, Hermes/UI adapter, dashboard, семь builtin directories, skill, README и MIT LICENSE.
- Необязательный `package.json` отсутствует в исходном commit и не считается ошибкой/несуществующим 44-м файлом.
- До/после native validation прочитаны metadata **714** записей всего временного home: mode/size/mtime_ns совпали, добавленных/удалённых/изменённых путей нет. Содержимое config/credential файлов не читалось; atime не сравнивался. Payload дополнительно перечитан по SHA после проверки.
- Доказательства: `evidence/p3-close-payload-readback.json`, `evidence/p3-close-final-integrity.json`.

### 3. Предшествующая установка — сохранена, не переисполнена

Скопированы реальные parent-логи с SHA-привязкой в `evidence/p3-close-provenance.json`:

- `evidence/p3-close-parent-p3-final-install.txt`: обычная установка exact local Git **exit 1**, scanner **CAUTION/BLOCKED**, 291 findings. Это не выдаётся за успешную обычную установку.
- `evidence/p3-close-parent-p3-final-install-forced.txt`: ранее выполненная установка с `--ref 610f92e7c8e1a697b909de22c357856b0ed191fc --force --no-enable --no-deps`, **exit 0**; plugin установлен, **не включён**.
- `evidence/p3-close-parent-p3-final-install.json`: родительская запись установки.
- README:31–36 прозрачно раскрывает локальный trust override `--force`, его scanner-эффект, reviewed self-authored scope и запрет переносить его на непроверенные плагины/отключать сканирование глобально.
- `--no-deps` относится к зависимостям плагина. Родительский install-log отдельно показывает подготовку isolated Hermes runtime; утверждение «вообще ничего не provisioned» к той старой установке было бы неверным. Этот проверяющий ничего не устанавливал.

### 4. Manifest, skill, README/SUBMISSION/catalog — проверено

- Manifest: `name: hermes-design-studio`, `version: 0.1.0`, MIT, `requires_hermes: >=0.22.5`, **7** tools; catalog draft согласован по tools/version/floor.
- Реальный native validation подтверждает синтаксис/registration на работающем fork-runtime. Он **не** доказывает совместимость с каждым upstream build, удовлетворяющим floor. README:19 прямо оговаривает эту границу.
- Canonical catalog entry schema реально получена HTTP 200 и сохранена: `evidence/p3-close-catalog-schema-source.md`; исходник `https://raw.githubusercontent.com/NousResearch/hermes-agent/main/plugin-catalog/README.md`, SHA-256 `5d9ab744164bfc1c48c99d0f3051e4cc9d203cebf355287727eebe7fb176a5f3`.
- Draft соответствует документированным полям/типам в проверенной части; отсутствующий обязательный `sha` намеренно обозначен как pending. **Catalog admission NOT READY**: публичный repo не проверен, immutable SHA и actual PR отсутствуют. Для требуемого P3 черновика это честное состояние, не успешная подача.
- README имеет описание, установку в два шага, remote/client topology, ручной и агентский workflow, ограничения GPU/форматов/экспорта/vision, roadmap, MIT и AI-assisted disclosure. SUBMISSION содержит PR draft, disclosure, post/video/form checklist без вымышленных URLs.
- Все явные относительные Markdown links в README/SUBMISSION/architecture guide существуют. Оба official documentation URLs реально ответили HTTP 200.
- **217 Unicode characters** в точном plain-text X draft, `@NousResearch` присутствует, ≤280. После добавления реальной ссылки нужен пересчёт по правилам платформы.
- **74 секунды** сценария: семь непрерывных интервалов, сумма и каждая duration совпадают; это укладывается в 60–80 и <90. Видео не записано/не измерялось; сценарий не доказывает длительность будущего файла.
- Focused pytest: `tests/test_usage_skill.py` + `tests/test_install.py` → **3 passed in 0.06s, exit 0**, без установки зависимостей. Полный suite не перезапускался.
- Доказательства: `evidence/p3-close-audit.json`, `evidence/p3-close-focused-tests.{json,stdout.txt,stderr.txt}`; проверяющий скрипт `evidence/p3-close-audit.py`.

### 5. P0/P1/P2 acceptance evidence — полностью прочитано read-only

Это аудит существующих evidence-файлов, **не новый live user workflow** и не повторение verifier-скриптов на пользовательском проекте.

- P0: `evidence/p0-runtime-verification.json` целиком; pass:true, новая session `20261111_191301_ea4a4b`, request `64434194c10f4c59b30030bf191a2e80`, detached render с закрытой страницей; настоящий upload **24673192 bytes**, matching SHA; Save as отмечен именно как explicit human confirmation, не автоматический тест локального файла.
- P1: `evidence/p1-runtime-verification.json` целиком; все четыре gates PASS. Реальная клиентская диагностика **7 tools / 25 cases**; **28 UI commands**, user-authored approved tool; export revision28 **1536×1024**, SHA `7fa86cbf6aab1925cfc439e47aff4b3c38ac115f12c80c44c1dd62a601e49642`, recorded Pillow verify+load. Ручная автономность/локальный Save as опираются также на человеческое подтверждение.
- P2: `evidence/p2-runtime-verification.json` целиком; fresh session `20261111_222455_71cfd9`, approval message **7091**, команды `215cbfd2d131485da1a8f232356d12ff` (**28→29**) и `27ec025b902347df8669fe404ec1b858` (**29→30**), source agent. Exact agent GLSL/manifest совпадают с checked request и approved manifest. Четыре frame/check/export records, настоящий closed-page client run, final export **1536×1024**, SHA `94d28cd071732fdfa49e79cf84313d8e126f3bfeeb2d6b5c6014a1c3ca1569eb`, recorded Pillow pass. Rejected malformed batch остаётся rejected, не считается командой.
- `evidence/p2-parent-suite.txt` реально содержит **355 passed, 8 warnings**, Node **55 pass, 0 fail**. `git diff` от `f3aef873e24173a28677c8f28606175762e60b55` до проверенного commit не содержит изменений executable/runtime paths. Изменены только документация/metadata/evidence/skill/read-only verifier. Поэтому новый полный suite не заявляется и не нужен для этой проверки.
- Хеши трёх исходных reports и извлечённые точные IDs/counts: `evidence/p3-close-audit.json` → `prior_acceptance_records`. Live histories, projects и PNG повторно не запускались/не изменялись.

## Оставшиеся gates для родителя

1. **Перед публикацией исправить privacy/caption mismatch скриншота.** Оба PNG реально открыты и просмотрены. `docs/screenshots/studio-p1.png` (1551×833, SHA `6cbad4c83d2b8a18caf5ad37c9d2c7f62a8f71fb5fc8cc96adf9f002a51d0619`) внизу показывает `Gateway: /home/destino/.hermes/plugin-data/...`, то есть имя пользователя и абсолютный серверный путь. README:119 и architecture guide:100 говорят, что такие пути обрезаны — текущие пиксели это опровергают. Токенов/реальных приватных чатов в просмотренном кадре не видно. Родителю следует обрезать/redact нижний путь или явно согласовать его публикацию и исправить подпись. Этот исполнитель не менял screenshot/README. Diagnostics screenshot показывает только pixelate/dither и начало таблицы; полные 7 PASS доказывает JSON, не картинка.
2. **Интегрировать delivery evidence и handoff.** README:5,113, SUBMISSION:41,53 и architecture:90 ссылаются на literal `evidence/p3-final-install.json`, которого ещё нет в tracked delivery worktree: он существует только как uncommitted файл родителя и как наша prefixed evidence-копия. Родителю включить настоящий record/logs + этот отчёт, обновить BUILD-LOG и pending checklist фактами, скопировать SUBMISSION в `/home/destino/projects/hermes-design-plugin/SUBMISSION.md` по брифу. Не менять исторический tested SHA на новый reports-only SHA задним числом.
3. **Изоляция: явно сохранить границу доказательства.** Exact isolated installed clone теперь валидирован default runtime exit0. Validation CLI с temp `HERMES_HOME` ранее timeout; этот запуск не повторён и не объявлен PASS. Если требуется именно полностью отдельный interpreter/runtime gate, он остаётся blocked/pending; никаких rebuild/provision обходов не сделано.
4. **P4/human gates не выполнены.** Публичный repo, проверенный final remote SHA, catalog PR/CI/review, privacy approval, реальное видео с измеренной длительностью, X post и form receipt требуют отдельных действий/авторизации. Здесь нет ни отправки, ни claims об их выполнении.

## Что передать дальше

Родитель может использовать доказанный результат: «существующий exact-commit isolated local-Git install read-back совпал по 43 payload-файлам; native CLI validate этого exact target через уже работающий default runtime завершился exit 0 с раскрытым CAUTION». Нельзя сокращать это до «обычный install без override безопасен» или «temp-runtime validation прошла».

Новые отчёты и evidence коммитятся только локально в `verify/p3-close`; итоговый SHA сообщается отдельно после реального commit/readback. Общая задача не переводится в completed.
