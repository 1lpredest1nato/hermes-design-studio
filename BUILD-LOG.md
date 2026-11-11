# Hermes Design Studio — журнал сборки

## Исходные условия

- Старт: 11.11.2026 18:42 МСК (реальный `date --iso-8601=seconds`).
- BUILD-BRIEF.md прочитан целиком (145 строк), затем SPIKE-BRIEF.md и SPIKE-RESULTS.md; проверенные факты приняты, дефекты lifecycle не переносятся как готовое решение.
- Репозиторий создан: `/home/destino/projects/hermes-design-studio/`, branch `main`.
- Границы: исходники репозитория, установленная копия только `hermes-design-studio`, собственные plugin-data, служебные результаты рядом с брифом. Core Hermes, другие плагины, config.yaml вручную не меняются. Публикации запрещены до отдельного согласия.
- Топология подтверждена пользователем: Desktop **на другой машине**, подключённой к этому gateway. Поэтому отдельная клиентская установка обязательна; gateway-side пакет сам по себе не доказывает клиентский runtime.
- Сервис gateway обнаружен read-only: `hermes-gateway.service`, active, `/home/destino/.config/systemd/user/hermes-gateway.service`. Однако process ancestry этой сессии позже показал **PID 362994, `hermes serve --isolated ... --ssh-session-token-file ...`**: это SSH-owned backend Desktop, не MainPID системного сервиса (256544). Поэтому перезапуск только `hermes-gateway.service` не считается перезапуском обслуживающего эту сессию backend. Handoff: полностью перезапустить клиентский Desktop и переподключиться к SSH-host; после подключения проверить routes/report. VPN/Tailscale не трогаем.
- Сроки: P0 19:20, P1 21:15, P2 22:30, P3 feature freeze 23:15 МСК. При недоказанном runtime — статус pending, не PASS.

## P0 — в работе

Команда разделена на два ограниченных потока: файловый bridge/HTTP и отсоединённый WebGL renderer/SDK. Коммиты делает родитель после самостоятельной проверки.

### Предварительные проверки родителя

- Установщик dev-копии написан через RED→GREEN: `python -m unittest discover -s tests -p test_install.py -v`.
- RED: 2 FAIL (установщик ещё отсутствует); GREEN: 2 tests OK. Логи: `evidence/p0-install-red.txt`, `evidence/p0-install-green.txt` в репозитории.
- Проверяется хеш каждого скопированного файла; evidence/test caches не отправляются в установленный пакет; symlink payload отклоняется.
- Официальная актуальная SDK-документация прочитана; локальный источник `plugin_host_wire.py` использует отдельный поток для каждого RPC. Это только инспекция; отсутствие дедлока и мультимодальный конверт ещё требуют исполнения.

### Контрольная точка 19:01 МСК — реализация готова, runtime требует человека

**Самостоятельно повторено родителем (не принято по самоотчёту подагентов):**

1. `python scripts/run_tests.py` с `TEST_EXTRA_PYTHONPATH` существующего pytest cache: **17 passed in 1.79s**, затем Node: **7 pass, 0 fail**. Полный вывод `hermes-design-studio/evidence/p0-parent-tests.txt`.
2. Реальный `hermes_cli.plugin_host.PluginHost`, Python **3.14.9**, отдельные PID parent **383145**, host **383148**. Вызван настоящий зарегистрированный `design_studio_preview` через `tools.registry`, пока он ждал — POST ответа через **тот же host** `asgi_request`. Ответ пришёл за **0.141446816 s**, `_multimodal: true`, image_url и text_summary сохранены после изоляции. request id **9a51fae48dd94c1ea25db3fce7e03bfa**. Это интеграционный тест, **не вызов агента в новой сессии и не клиентский SDK-прогон**. Вывод/JSON: `evidence/p0-host-integration.{txt,json}`.
3. Через настоящий host ASGI multipart передан **валидный PNG 2400×2400, 23 049 735 байт**, **6** кусков ≤4 MiB. SHA-256 **7004566e60daff67ac2bd0a981a955346c43992bd90d24c0a9bd23db54bdc71e** совпал с собранным файлом. Pillow `verify()` и полный `load()` прошли. Файл: `evidence/host-home/plugin-data/hermes-design-studio/assets/7004566e60daff67ac2bd0a981a955346c43992bd90d24c0a9bd23db54bdc71e.png`. Это тестовые данные в изолированном HERMES_HOME, не пользовательский проект.
4. `node tests/p0-headless.mjs`: отдельный **Chromium 155 / software WebGL**, отсоединённый canvas отрисовал точные ожидаемые 16 RGBA-байт; dispose блокирует следующий render. Сгенерированный настоящий PNG **24 673 096 байт**. Это **вторичное** доказательство: `evidence/p0-parent-headless.json`, не Hermes Desktop PASS.
5. Сборка: `npx --yes esbuild@0.28.2 hermes/plugin.jsx --bundle --format=esm --jsx=automatic --external:@hermes/plugin-sdk --external:react --external:react/jsx-runtime --outfile=desktop/plugin.js --metafile=evidence/esbuild-meta.json`. Успешно, readable ESM **22.8 KiB**; полный вывод `evidence/p0-build.txt`.
6. `python scripts/install_dev.py`: **copy_verified:true**, 13 файлов в `/home/destino/.hermes/plugins/hermes-design-studio/`, копия не симлинк, SHA каждого файла совпал. `evidence/install.json`.
7. `hermes plugins validate /home/destino/.hermes/plugins/hermes-design-studio`: **exit 0**, `security scan — safe`, `desktop surface — stays inside the plugin SDK surface`, `Validation passed.` Полный stdout: `evidence/p0-validate-installed.txt`. Предупреждений нет; информационно host isolation/buffered responses. `requires_hermes` пока не объявлен — добавить к поставке P3.
8. `hermes plugins enable hermes-design-studio --no-allow-tool-override`: enabled, CLI сообщает `Gateway reloaded plugins — deferred: tools (next session)`. Read-back `hermes plugins info hermes-design-studio`: **Status: enabled**. `evidence/p0-enable.txt`. Gateway/Desktop **не перезапускались**.

**Проверенные fallback/решения:**
- Последовательного дедлока tool wait → HTTP response в проверенной host-конфигурации нет; мультимодальный конверт проходит. Сохранён proactively cached preview + stale revision fallback и polling.
- Сервис создаёт один canvas в `register(ctx)`, независимый от routes; постоянный SDK titlebar contribution монтирует невидимый `useQuery` poll. `ctx.onDispose` отменяет дальнейшие POST и освобождает GPU; JS-тесты проверили отмену во время PNG и незавершённого IPC.
- На probe-странице нет автоматического download click: Save as запускает только человек. Подтверждение системного диалога — отдельная кнопка, не автоматически выставленный PASS.

**Наблюдавшиеся сбои тестового окружения (не скрыты):**
- Первый запуск PluginHost во временном HERMES_HOME запустил автоматическое provision зависимостей и не ответил до timeout. Причина установлена по import log: `preparing dependencies for this data root`; не зависит от 3.11/3.14. `HERMES_DISABLE_LAZY_INSTALLS=1` использует имеющийся runtime и устраняет bootstrap/re-exec. `evidence/p0-host-launch-imports.txt`, `p0-host-preflight.json`. Созданное только этим тестом временное дерево зависимостей удалено; fixture PNG сохранён. Hermes core не редактировался.
- Первая валидация исходного дерева с этим большим вложенным тестовым environment получила timeout 90s, пустой stdout. Валидация точной установленной копии без evidence завершилась exit 0. Timeout не выдаётся за успешную валидацию.

**Остановка на обязательном человеческом шаге; P0 НЕ объявлена полностью пройденной:**
- На клиенте ещё нет подтверждённой Desktop-копии, плагин не включён в UI и runtime report не прочитан.
- Pending: реальный клиентский `ctx.rest` ≥20 MiB upload с SHA read-back; ответ сервисного renderer при закрытой странице; native Save as dialog; новая сессия с реальным вызовом preview.
- Следующая фаза P1 не начинается до этого handoff. Ближайшая отсечка 19:20 сохраняется.

### Полный вывод P0 validation установленной копии

Команда: `HERMES_DISABLE_LAZY_INSTALLS=1 hermes plugins validate /home/destino/.hermes/plugins/hermes-design-studio`, exit **0**.

```text
✓ manifest — plugin.yaml parses
✓ manifest fields — name, version, description present
✓ requires_hermes — not declared
✓ config schema — not declared
✓ requires_env — all entries UPPER_SNAKE
✓ oauth — not declared
✓ loadable — entry: __init__.py, desktop/plugin.js
✓ python dependencies — none declared
✓ capability probe — register() ran in isolation
✓ declared tools — matches registrations
✓ declared hooks — matches registrations
✓ declared middleware — matches registrations
✓ built-in tool collisions — no collisions
✓ security scan — safe
✓ no core override — no runtime rebinds of Hermes core
✓ desktop surface — stays inside the plugin SDK surface
◆ Isolation — runs in the plugin host (plugins.isolation: host)
  · dashboard backend API is served through the plugin host (buffered responses)

Validation passed.
```

`git diff --cached --check` отметил trailing whitespace в необработанных логах тестов/CLI и пустые строки EOF; это не падение тестов. Исходные stdout доказательств не переписывались ради косметики. Бинарные payloads в staging отсутствуют; `git status --short` после checkpoint commit пуст.

## P0 — закрыта после реального клиентского прогона (19:16 МСК)

`PYTHONDONTWRITEBYTECODE=1 python tests/verify_p0_runtime.py` — **exit 0, pass:true**. Скрипт независимо связал read-only историю сессии, request/response JSON, отчёт Desktop и реальные файлы. Полные доказательства: `evidence/p0-runtime-verification.{json,txt}`, снимок `evidence/p0-client-report.json`.

- Новый session id **20261111_191301_ea4a4b**. User message **5069**: `Вызови design_studio_preview и покажи результат`; настоящий call **5072**, результат **5073**, call id **call_f8b05ae177f949988023c4ef391c8daf**.
- request id **64434194c10f4c59b30030bf191a2e80** совпал в tool result, `requests/`, `responses/` и `report.renders`. Run id **a9733829-9260-4d68-8f3b-b93e5b7f84a3**. Реальный service render: **page_active:false**, **detached_canvas:true**, `via:poll`, `revision:0`, `stale:false`; ответ при закрытой странице доказан.
- Превью **640×400**, **6927 байт**, SHA **fe12518aeed1040038c0084b8006b00bbec199cfbe8513591645e2f1c2bd4a7d**. Pillow verify + load прошли. Текстовые метрики сохранены в настоящем tool result; скриншот пользователя показывает изображение, не только текст. Это P0 fixture, не обработка пользовательского изображения.
- **Настоящий клиентский ctx.rest upload:** **24 673 192 байт**, 6 chunks, PNG **2560×2400**; SHA **c2fc8edcd364dabccd135eab826454fbba954abee6324cf0aea45aa2281f767f** совпал с самостоятельно пересчитанным SHA файла в `plugin-data/hermes-design-studio/assets/`. Pillow verify + load прошли. Поле `upload_probe.status:complete`, `sha256_match:true`.
- **Save as:** `save_as.dialog_verified:true`, `evidence:explicit-user-confirmation`; человек подтвердил системный диалог в UI и написал, что выполнил шаги. Агент не нажимал подтверждение за человека.
- Клиентский плагин успешно загружен (скриншоты пользователя + точный build id). Перезапуск Desktop выполнил человек; агент ничего не перезапускал. P0 закрыта до 19:20.

## P1 — начало 19:16 МСК; отсечка 21:15

Переходим к командам/ревизиям, полноценному renderer со стеком, 7 встроенным инструментам, ручному авторингу и диагностике. P0 код остаётся исходной контрольной точкой, а не доказательством P1-функций.

### P1 — промежуточные реальные доказательства (20:06 МСК)

- Родитель повторил `python scripts/run_tests.py`: **224 passed, 8 warnings** (fork в многопоточном pytest-процессе; тестовая Linux multiprocessing-конфигурация), затем **35 Node tests, 35 pass**. `evidence/p1-parent-suite-second.txt`. Логи RED→GREEN отдельных интеграционных изменений сохранены отдельно, включая исходные сбои окружения и промежуточные падения незавершённых параллельных тестов — они не переименовываются в PASS.
- Родитель повторил `node tests/p1-render-headless.mjs`: **33/33 проверки pass**. `node tests/p1-diagnostics-headless.mjs`: **7/7 инструментов**, **25 наборов параметров**, **6400 RGBA-каналов**, **max error 0**, плюс **7 фиксированных JSON fixtures** и `mutation_detected:true` для заведомо изменённого шейдера. Сводка посчитана из JSON кодом, не из самоотчёта подагента. `evidence/p1-parent-{renderer,diagnostics}.json`. Среда: отдельный Chromium 155 / software WebGL, **не клиентский Desktop**.
- `python tests/p1_service_integration.py`: настоящие HTTP API + браузерные core/service: PNG upload→set_source→два узла→preview→current/test compile→ошибка GLSL→export→diagnostics, **exit 0**; `uncaught_errors:[]`. Экспорт **64×48**, SHA **eb34922b590647cce0438385f5d859add1aeddc1149bc14c07a7096e89ec4a75**, Pillow verify+load прошли. Измерены difference_source **0.33037513616557734**, difference_previous **0.18513071895424837**. `evidence/p1-parent-service-integration.json`; PNG лежит в изолированных test-data, не отправляется в пакет. Это **автоматизированный интеграционный тест, не доказательство ручного одобрения**.
- Добавлены/проверены: scoped cache по project id+revision; ограниченное чтение ассетов 1 MiB JSON/base64 через ctx.rest с SHA; proactive upload готового page-preview (debounce 300 ms); ошибки компиляции завершают запрос без вечного pending; source-less frame честно маркируется fixture; ручные New project и seed controls; две темы/два экспорта/ручной редактор и рецепты.
- API-блокеры после прерванного подагента дописаны отдельным fix-потоком: render/error, recipes, diagnostics, immutable backend check snapshot; schema fingerprint сравнивается под каталоговым lock. В production-source нет eval/new Function/секретов; regex `.exec()` в assets.mjs отмечен сканером как проверенный false positive.

**Блокер ревью — исправляется до поставки:** независимый reviewer воспроизвёл изменение НОВОГО проекта командой из старой вкладки при совпавшей ревизии. Родитель отдельно воспроизвёл `wrong_project_mutated:true`. `evidence/p1-review-core.md`. Мутационный envelope усиливается обязательным **project_id + base_revision** для UI, backend и будущего agent apply; это небольшое совместное расширение рабочего контракта, не изменение архитектуры. До зелёной regression-проверки P1 не передаётся клиенту.

P1 ещё в работе. Реальный клиентский diagnostics.json, ручной авторинг/одобрение без агента и PNG из пользовательской библиотеки **пока не доказаны**.

### P1 — ревью и второй цикл исправлений

- Защита backend по паре `project_id + base_revision` подтверждена родителем: полный повторный прогон **249 pytest passed, 8 fork warnings + 40 JS tests passed**, exit 0; `evidence/p1-parent-suite-final.txt`. Обновлённый HTTP→service→WebGL→PNG тест также exit 0 (`evidence/p1-parent-service-final.txt`).
- Независимое JSON-ревью `evidence/p1-precommit-review.json` вернуло **passed:false**: (1) очередь UI присваивала project id при отправке, а не при постановке; (2) редактор мог показать исходник A, проверить backend-вариант B и одобрить только по id; (3) bitmap, декодированный после unload, оставался незакрытым. Эти дефекты не скрываются зелёным suite.
- (1) Исправлен отдельным контекстом с RED→GREEN. Родитель независимо повторил New project→отложенный старый seed: **1 POST**, старый seed отклонён **409**, `conflicts:1`, никакой записи в новый проект; `evidence/p1-parent-queued-repro.json`. При параллельной работе над (2) один старый mocked-UI тест оказался FAIL; причина ещё проверяется fix-потоком. Промежуточный результат сохранён в `evidence/p1-parent-queued-identity.txt`, итоговая проверка будет повторена после завершения fix-потока.
- (2) и (3) исправляются до сборки: ожидаемые hash исходника и манифеста связывают проверку, показанный preview и явное человеческое одобрение; bitmap закрывается и при отмене декодирования.
- Подготовлен read-only аудит `tests/verify_p1_runtime.py`: прямо сейчас **exit 1**, все четыре клиентских gate FAIL (нет diagnostics/current-project/P1 preview/export), как и должно быть до установки P1 на ноутбук. `evidence/p1-runtime-before-client.txt`. Аудит не создаёт проект, команды, инструменты и не одобряет их. Он не выдаёт текстовую сводку из UI-кадра за настоящий агентский tool call.
- Инструкция будущего ручного прогона: `../hermes-design-plugin/P1-CHECK.md`. Она ещё не является подтверждением выполнения. Ни Desktop, ни gateway агент не перезапускал.

### P1 — сборка готова к человеческому gate (20:40 МСК)

Второй цикл исправлений завершён. Итоговое независимое ревью **passed:true**, security_concerns/logic_errors пусты (`evidence/p1-precommit-review-final.json`). Родитель проверил SHA-256 всех шести production-файлов из ревью: **совпадают**, значит ревью относится к поставляемому snapshot.

- `PYTHONDONTWRITEBYTECODE=1 python scripts/run_tests.py -p no:cacheprovider` → **253 passed, 8 warnings**, затем **49 JS tests / 49 pass / 0 fail**, exit 0. Полный вывод: `evidence/p1-parent-suite-approved-snapshot.txt`. Fork warnings остаются известным ограничением многопоточного тестового процесса, не скрыты и не подавлены.
- Настоящий loopback HTTP→browser service→WebGL2→PNG/Pillow после последних исправлений: **PASS, exit 0**, `uncaught_errors:[]`; `evidence/p1-parent-service-approved-snapshot.txt` и `evidence/p1-parent-service-integration.json`. Это вторичный browser-тест, не клиентский Desktop.
- Повторная диагностика: **7 инструментов PASS**, **7 статических fixture PASS**, мутация шейдера обнаружена; `evidence/p1-prehandoff-diagnostics.{txt,json}`.
- `esbuild@0.28.2`: readable ESM, **113826 bytes**. Внешние импорты только SDK/React, forbidden literals отсутствуют. Bundle SHA-256 **f791ca76dd95037caf0a84bc106c17b6722802c70015c61bf4f0f2d6d2b16e47**; `evidence/p1-bundle-final.json`.
- Установлена dev-копия в разрешённый `~/.hermes/plugins/hermes-design-studio/`: **41 файл**, не symlink; installer проверил каждый хеш, затем родитель независимо повторил чтение всех 41 target-файлов и сравнение SHA. `evidence/p1-install.json`.
- `HERMES_DISABLE_LAZY_INSTALLS=1 PYTHONUNBUFFERED=1 hermes plugins validate ~/.hermes/plugins/hermes-design-studio` → **Validation passed, exit_code=0**, security scan safe, desktop SDK surface pass, declared tools match. Полный вывод `evidence/p1-validate-installed.txt`. Предупреждений установленного пакета нет; `requires_hermes` пока not declared, заполнится в P3. Проверка исходного репозитория также exit 0, но даёт caution на буквальную запись exec в файле доказательств сканера — эти доказательства не входят в dev payload; `evidence/p1-validate-source.txt`.

**Обязательный STOP перед перезапуском №2 и ручной проверкой на ноутбуке.** Клиентский bundle пока не установлен агентом (другая машина), Python-маршруты текущего gateway агент не перезапускал. P1 НЕ закрыта, P2 не начата. Осталось человеку: обновить plugin.js, закрыть/открыть Desktop и переподключиться к SSH-host; запустить диагностику; вручную импортировать/обработать изображение, создать/одобрить/применить свой инструмент, сохранить локальный PNG и отдельно Save to library, прислать скриншоты и `/goal resume`. После этого родитель выполнит `tests/verify_p1_runtime.py`, проверит Pillow и закроет фазу отдельным коммитом. Отрезанного объёма P1 на этом checkpoint нет.

### P1 — закрыта по реальному клиентскому прогону (21:03 МСК)

Пользователь прислал шесть скриншотов и явно подтвердил: «создал и одобрил вручную без агента»; системный Save as появился, локальный PNG сохранён. Это человеческое подтверждение клиентского диалога, не автоматическая проверка локального файла на другой машине.

Родитель выполнил `PYTHONDONTWRITEBYTECODE=1 python tests/verify_p1_runtime.py`: **exit 0, pass:true**, все четыре gate PASS — diagnostics, manual_project, preview, exports. Полный вывод `evidence/p1-runtime-after-client.txt`, структурированные доказательства `evidence/p1-runtime-verification.json`.

- Реальный клиентский run **17b738dd-93ce-4d8f-821e-f6d5f5f734a5**, build `design-studio-p1-20261111-studio-1`; `diagnostics.json`: все семь инструментов PASS. Это уже клиентский Desktop, а не standalone Chromium.
- Проект **75efd24dc3174b02a8668948953fe80b**, revision **28**, **28 UI-команд**; в проекте нет agent-команд. Инструмент **user/my-tool@1** создан с provenance.author **user**, approved-манифест существует и инструмент включён в итоговый стек. Его исходник — начальный проходной шаблон; параметр amount1 пока не используется, что не является ошибкой компиляции.
- Экспорт request **6d225cdcc80d41a3b64227d2b9180696** той же revision 28 и того же run; файл `exports/7fa86cbf6aab1925cfc439e47aff4b3c38ac115f12c80c44c1dd62a601e49642.png`: **1536×1024, 305312 bytes**, SHA-256 **7fa86cbf6aab1925cfc439e47aff4b3c38ac115f12c80c44c1dd62a601e49642**, Pillow verify+load PASS. Актуальный preview той же project id/revision с полными метриками также проверен аудитом.
- Замечание пользователя «хроматическая аберрация ... или ditherify»: в скриншоте и сохранённом документе Chromatic Aberration **enabled:false**, offset 2 px; далее включён Ordered Dither, matrix 4, levels 4, use_palette false. Родитель независимо посчитал цвета настоящего экспортированного PNG: ровно **4** непрозрачных цвета — RGB **0, 85, 170, 255**; dither действительно применяется. Последующий grayscale dither также скроет цветное расхождение каналов, поэтому проверять аберрацию нужно включённой и временно без последующего dither. Это объясняет текущий кадр; общего отсутствия ошибок во всех сочетаниях не утверждаем.

**P1 закрыта до 21:15.** Следующая фаза — P2 после `/goal resume`; настоящая новая агентская сессия и корреляция tool calls с command ids по-прежнему не выполнены и не заменяются этими UI-доказательствами.

## P2 — агентные инструменты; checkpoint перед человеческим gate

- Реализованы и зарегистрированы ровно **7** `design_studio_*`, `provides_tools` совпадает; явное `ctx.register_skill('usage', ...)` даёт `hermes-design-studio:usage`. Нет регистрации/скрытого пути одобрения из adapter. `apply` и recipe apply требуют project_id + base_revision, source agent. Создание tool возвращает реальный compile receipt/PNG/метрики либо честный pending/error, никогда не одобряет черновик. Экспорт не подменяется cached preview.
- Серверный import — stdlib-only, streaming SHA/atomic publish без потолка размера файла, PNG/JPEG/static WebP metadata, ориентация JPEG учтена; root/destination symlink/path guards. Это **проверка заголовков**, не полный декодер: повреждённые сжатые пиксели могут быть отвергнуты только настоящим браузерным декодированием. Ограничения форматов будут перечислены в P3 README.
- Исправлен обнаруженный при подготовке P2 provenance-дефект: открытие неизменённого agent draft в UI больше не POST-ит его заново с author user. Preview-only параметры и новая project revision перепроверяют исходный immutable snapshot; изменения GLSL требуют нового сохранения и fingerprint checks. Ручное одобрение по-прежнему только кнопкой с проверенными хешами.
- Родитель: полный runner **355 pytest passed, 8 fork warnings + 55 JS tests passed**, exit 0 (`evidence/p2-parent-suite.txt`). После смены build id на P2 повтор Node выявил старую проверку именно P1-метки; тест законно обновлён на точную P2-метку без ослабления UI/renderer asserts, итог **55/55 PASS** (`evidence/p2-node-final.txt`; промежуточный FAIL сохранён).
- `tests/probe_p2_host.py`: настоящий отдельный PluginHost PID **546401**, реальный Chromium WebGL и HTTP через тот же host: **11 зарегистрированных handler calls / 7 уникальных инструментов**, source import→atomic apply→fresh multimodal preview→реальная GLSL compilation/fixture→отказ применить неодобренный draft→recipe save/list/apply→PNG export. **pass:true, browser_exit:0**; `evidence/p2-host-integration.{json,txt}`. Три source-agent command ids/revisions **0→1→2→3** сверены с настоящим isolated commands.jsonl. PNG **64×48**, SHA **c37c95047d0e6ff148f953a00e9eee38018a89eb98b51d8e27582e86c1d633d5**, Pillow PASS. Skill реально зарегистрирован через host. Ни Desktop SDK, ни LLM, ни человеческое одобрение этим тестом НЕ доказаны. Первый прогон прошёл handler/GPU-часть, но был FAIL на cleanup: Node stdin оставался открытым; stdin lifecycle исправлен, оба сырых результата сохранены.
- Независимое P2-ревью **passed:true**, concerns/errors пусты; родитель сверил SHA всех пяти reviewed production-файлов (`evidence/p2-precommit-review.json`). Замечание ревью про первый browser_exit -9 относится к сохранённому первому прогону; последующий фактический повтор уже exit 0. Последующее изменение plugin.jsx — только build provenance tag, плюс повторная сборка.
- Установлена dev-копия **43 файла**, installer и родитель прочитали/сверили каждый SHA; `evidence/p2-install.json`. Readable bundle build **design-studio-p2-20261111-agent-1**, SHA **0b1046ab0c5466102f1302dc247ce841bdf85bc37269dc9e75832bcfc9572e9d**. Полный `hermes plugins validate ~/.hermes/plugins/hermes-design-studio` → **Validation passed / exit 0**, security safe, SDK surface pass (`evidence/p2-validate-installed.txt`).
- До пользовательского агентного прогона сохранён настоящий baseline: project **75efd24dc3174b02a8668948953fe80b**, revision **28**, **28** старых UI-команд; `evidence/p2-live-baseline.json`.

**STOP:** требуется последний запланированный перезапуск Desktop/переподключение SSH и новая агентская сессия. P2 ещё не закрыта. Нужно в новой сессии загрузить bundled skill, получить каталог/документ, сохранить рецепт, применить команды, увидеть preview, создать новый shader draft; пользователю одобрить его в UI; в той же новой сессии применить одобренную версию, preview и export. После `/goal resume` родитель сверит настоящие tool-call ids/results в истории с новыми commands.jsonl/request/response/frame/export, допишет доказательства и закроет P2 отдельным коммитом. Ни Desktop, ни gateway агент не перезапускал.




