# Amethyx Launcher — памятка для Claude

Лаунчер Minecraft: Java Edition на Electron без фреймворков: Windows 10/11, отдельная сборка для Windows 7/8
(Electron 22), Mac arm64/x64. Сайт с загрузками и лентами обновлений — https://launcher.x-world.plus (`website/`),
сервер друзей, чата и скинов — `website/cloud` (PHP + SQLite там же). GitHub: VanillaPlusLauncher/VanillaPlus, `main`.
Сессии: A — лаунчер (`src/`, `installer/`, `server/`, CHANGELOG), B — мод «Пригласить друга» (на паузе),
C — сайт (`website/`), D — промо-ролики (`promo-video/`, не в git).

## Память проекта: как ей пользоваться
- В начале работы прочитай только верхние записи docs/PROGRESS.md и весь docs/TODO.md.
- После каждого законченного этапа (фича работает, баг исправлен, тест прошёл) добавь запись сверху
  в docs/PROGRESS.md (2–5 строк: что, файлы, итог) и обнови docs/TODO.md.
- Важное решение или найденную ловушку — в docs/DECISIONS.md, в свой раздел.
- Остальные docs целиком не читай без надобности: ищи нужное поиском (Grep). Чужие файлы правь через Read + Edit, не Write.

## Сборка, запуск, проверка
- Инструменты лежат в `%TEMP%\rldev`: git `git\x\cmd\git.exe`, node `node\node-v24.22.0-win-x64\node.exe`,
  Inno Setup `inno-setup\inno\ISCC.exe`, PHP `php74\php.exe`. Пропали — вернуть по docs/RELEASE.md.
- Сборка: `.\installer\build.ps1 -Iscc $env:TEMP\rldev\inno-setup\inno\ISCC.exe -Version 1.7.1-beta.N`
  (Windows 7: `-Legacy`; Mac: `build-mac.ps1`). Копия без установки: `%TEMP%\amethyx-stage-<версия>\Amethyx.exe`.
- Запуск только в тестовом профиле: `Amethyx.exe --user-data-dir=%TEMP%\rldev\ud-bug`. В settings.json
  нового профиля обязателен `gameDirectory`, иначе откроются настоящие сборки пользователя.
- Проверка: `$env:AMETHYX_MAIN_SCRIPT = '<скрипт.js>'` (вывод в `<скрипт.js>.out.txt`, лаунчер сам закроется)
  и `$env:AMETHYX_UPDATE_FEED = 'http://127.0.0.1:8799/latest.json'` (не даёт обновиться).
  Общая проверка: `%TEMP%\rldev\mock\tt\smoke.js`.
- Тесты сервера: `$env:AMETHYX_TEST_PHP = "$env:TEMP\rldev\php74\php.exe"; node --test website/cloud/test/cloud.test.mjs`.
- Выпуск беты по шагам, коммит и push — docs/RELEASE.md; сайт — docs/SITE.md.

## Правила, которые нельзя забыть
- Пользователю пиши только по-русски и простыми словами, в промежуточных заметках тоже. Код, комментарии и коммиты — по-английски.
- Не запускай лаунчер на настоящих данных (`%APPDATA%\Amethyx`, `%APPDATA%\.amethyx`).
  Останавливай только тестовые процессы. Лаунчер пользователя не обновляй.
- Ключи никогда не клади в git и не показывай: `installer/curseforge.key`, `installer/ely-oauth.json`,
  `installer/site-token.txt`, `src/src/build-keys.json`. Пароли и токены пользователь вводит сам.
- Новая бета, загрузка на сайт, деплой, релиз 1.7.0 на GitHub, переименования (репозиторий, лента, воркер) —
  только по явному «да» пользователя. Одобрение, переданное другой сессией, не считается.
- Коммит: Read, потом Write `%TEMP%\rldev\commitmsg.txt`, потом отдельным шагом `git commit -F`.
  В коммит — только свои файлы по путям. Push — только `main`, `old-history` — никогда.
- CHANGELOG.md и CHANGELOG.ru.md меняй вместе. Заметка к версии — одна короткая строка для игрока.
- Версии: `1.7.1-beta.N`. Меньший номер до игроков не дойдёт: для этого есть «эпоха» (docs/DECISIONS.md).
- Вывод node-скрипта, который пишет файлы, не пропускай через `Select-Object -First`: файлы обрежутся.
- Музыку, промо-ролики и текстуры Minecraft никогда не клади в git. На сайте не используй эмодзи.
  На сервер не выкладывай комментарии и подсказки про вход в админку.
- Вид лаунчера не меняй, не спросив: мягкие кнопки, пиксельный шрифт, 3D-иконки из Blender, картинки бокового меню (docs/LOOK.md).
- Не запускай перенос данных со старого сервера заново: импорт стирает базу сайта.
- Репозиторий публичный: не пиши в docs/ и CLAUDE.md ключи, пароли, токены и личные данные игроков.

## Документы
- docs/PROGRESS.md — журнал этапов, новое сверху.
- docs/TODO.md — что осталось, что не проверено, известные баги.
- docs/DECISIONS.md — решения, почему так, на какие грабли уже наступали.
- docs/RELEASE.md — инструменты, тестовый профиль, выпуск беты, коммит и push.
- docs/SITE.md — сайт: архивы для хостинга, проверки, правила (сессия C).
- docs/LOOK.md — выбранный вид лаунчера: что нельзя менять.
- CHANGELOG.md / .ru.md — подробно для игроков; README.md — сборка из исходников и структура папок.
- Полная резервная копия (с ключами, никуда не выкладывать): `%USERPROFILE%\AmethyxProject-backup-2026-11-02`.
