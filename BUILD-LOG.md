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

