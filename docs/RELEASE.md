# Выпуск, проверка, инструменты

Всё, что ниже, делается только по явному «да» пользователя (выпуск обновления, публикация, push).

## Инструменты (общие на весь компьютер, с 2026-11-07)
Своих копий не скачивать: одна копия на все проекты, список — `%USERPROFILE%\Tools\README.md`.
Нужного нет — поставить туда (`%USERPROFILE%\Tools\<имя>`) и дописать строку в README.

| Что | Путь |
| --- | --- |
| git | `%USERPROFILE%\Tools\git\cmd\git.exe` |
| Inno Setup | `%USERPROFILE%\Tools\inno-setup\ISCC.exe` (build.ps1 находит сам) |
| rcedit 2.0.0 | `%USERPROFILE%\Tools\rcedit\rcedit-x64.exe` (build.ps1 находит сам) |
| rcodesign 0.29.0 | `%USERPROFILE%\Tools\rcodesign\rcodesign.exe` (build-mac.ps1 находит сам) |
| ffmpeg | `%USERPROFILE%\Tools\ffmpeg\bin\ffmpeg.exe` |
| PHP 7.4 | `%USERPROFILE%\Tools\php74\php.exe` |
| node 24, python 3.13, gh | в PATH (gh: `%LOCALAPPDATA%\Programs\gh\bin\gh.exe`, вошёл как VanillaPlusLauncher) |

Electron для сборки лежит в проекте и в git не идёт: `build\Amethyx`, `build\Amethyx-win7`, `build\electron-mac-<версия>`.
Старые копии инструментов в `%TEMP%\rldev` больше не нужны; там остаются только тестовые данные (ниже).

## Тестовый профиль
- Тестовые данные в `%TEMP%\rldev` — не удалять при чистке: скрипты проверок `mock\tt` (их нет в репозитории),
  профиль `ud-bug` + `game-bug`, `commitmsg.txt`, `commitmsg-site.txt`.
- Сейчас: `%TEMP%\rldev\ud-bug` (без аккаунта, папка игры `%TEMP%\rldev\game-bug`, сборка «Тест модов»).
- Новый профиль: папка для `--user-data-dir` с `settings.json`, где есть `gameDirectory` (тестовая папка игры),
  `updates.autoCheck/autoDownload/autoInstall = false`, `social.online = false`. Без `gameDirectory` откроются
  настоящие сборки пользователя.
- Чтобы тестовая копия не обновилась по-настоящему: `$env:AMETHYX_UPDATE_FEED = 'http://127.0.0.1:8799/latest.json'`.
- Скрипт в main-процессе: `$env:AMETHYX_MAIN_SCRIPT = '<file.js>'` — модуль `async ({ log, window, load }) => {}`,
  `load('./updates/updateService.js')` берёт модули лаунчера (от `src/src/main`). Вывод — `<file.js>.out.txt`,
  потом лаунчер закрывается. Общая проверка сборки: `%TEMP%\rldev\mock\tt\smoke.js` (версия, сервер, карты,
  страница сборки, ленты с эпохой, ошибки консоли).
- Скриншот: `AMETHYX_SCREENSHOT=<png>`, `AMETHYX_SCREENSHOT_ROUTE=<route>`, `AMETHYX_SCREENSHOT_SCRIPT=<js>`.
  Обучение при первом запуске закрывает экран: в скрипте поставить `localStorage['amethyx.tour.done']`.
- Останавливать только тестовые процессы (пути `%TEMP%\amethyx-stage-*`), лаунчер пользователя не трогать.

## Тесты сервера
- `website/cloud`: `$env:AMETHYX_TEST_PHP = "$env:USERPROFILE\Tools\php74\php.exe"; node --test website/cloud/test/cloud.test.mjs`.
- Старый воркер Cloudflare: `server/test/worker.test.mjs`.

## Выпуск обновления по шагам
Версии `X.Y.Z` без беты: 1.7.2, 1.7.3 … 1.7.9, затем 1.8.0 (docs/DECISIONS.md, «Версии и обновления»).
1. `.\installer\build.ps1 -Version 1.7.N` (без `-Publish`). Готовая копия: `%TEMP%\amethyx-stage-<версия>\Amethyx.exe`.
2. Запустить её в тестовом профиле со `smoke.js`, прочитать `.out.txt`.
3. Заметка — одна короткая строка для игроков в UTF-8 файле. Затем
   `.\installer\publish-site.ps1 -File build\Amethyx-Setup-<версия>.exe -Channel release -Latest -Version <версия> -Notes (Get-Content -Raw -Encoding utf8 <файл>)`.
   Канал только `release`: в бете обновление не увидят лаунчеры без «beta» в номере.
4. То же для Windows 7: `build.ps1 … -Legacy`, затем `publish-site.ps1` с файлом `build\Amethyx-Setup-<версия>-win7.exe`.
5. Mac в фоне (~12 минут, дольше лимита команды):
   `.\installer\build-mac.ps1 -Version <версия> -Publish -Notes 'Открывается без Терминала: «Системные настройки» → «Конфиденциальность и безопасность» → «Всё равно открыть».'`
6. Проверить `https://launcher.x-world.plus/updates/latest.json`, `latest-win7.json` и `api.php?a=site` (версия,
   заметка, sha256, размер). Если PowerShell не запускается (EPERM) — через встроенный браузер.
7. CHANGELOG.md и CHANGELOG.ru.md — вместе; записать этап в docs/PROGRESS.md.
8. Убрать промежуточное (места на диске мало): `%TEMP%\amethyx-stage-*` кроме новой версии (и её `-win7`),
   тестовые `-tN`; в `build\` — установщики и zip прошлых версий (последний комплект оставить).

## Коммит и push
- Сообщение по-английски: Read, затем Write `%TEMP%\rldev\commitmsg.txt`; отдельным шагом
  `git commit -F %TEMP%\rldev\commitmsg.txt -- <свои файлы>`. Сайт (сессия C) пишет в `commitmsg-site.txt`.
- Push только `main`:
  `git -c credential.helper= -c "credential.https://github.com.helper=!'<gh.exe>' auth git-credential" push -q origin refs/heads/main:refs/heads/main`
  (`<gh.exe>` — `%LOCALAPPDATA%\Programs\gh\bin\gh.exe` с прямыми слешами).
  Код выхода 255 — норма; проверить `git status -sb` → `## main...origin/main`. Ветку `old-history` не пушить никогда.

## Сайт и перенос данных
- Сборка архивов сайта и его проверки — docs/SITE.md (сессия C).
- Перенос данных со старого сервера — `server/tools/README-migrate.md`. **Больше не запускать**: импорт очищает
  базу сайта, а игроки уже пользуются новым сервером. Выгрузки `.sql` — удалить после работы, в git не класть.
