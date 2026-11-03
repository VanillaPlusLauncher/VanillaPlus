# Сайт launcher.x-world.plus (сессия C)

Код — `website/`; сервер лаунчера — `website/cloud/` (его пишет сессия A, тесты — `website/cloud/test`).
Хостинг владельца: ispmanager, nginx → Apache, PHP 7.4+, перед PHP — фронт-сервер хостинга из его внутренней сети.

## Что где
- `index.html`, `styles.css`, `script.js` (тексты ru/en, загрузки, инструкция для Mac), `geode.js` (стартовая анимация).
- `api.php` (публичное: `a=site|me|hit`; админка: вход, версии, загрузка частями, токены), `dl.php` (скачивание, счётчик).
- `lib/amethyx.php` — общее ядро: база SQLite в `amx_data_dir()`, сессии, блокировка входа, адрес посетителя
  (`amx_client_ip`), токены (`amx_token_user`), ленты обновлений `updates/latest|beta(-win7).json`.
  Сигнатуры этих функций использует `cloud/` — менять только вместе с A.
- `admin/` — админка (только по адресу /admin/, в robots.txt её нет).
- Не в git (только на сервер): `assets/video/` (ролики с музыкой), `assets/mc/` (6 настоящих текстур аметиста), `data/`.

## Собрать архивы для хостинга
```powershell
.\installer\site\build-package.ps1            # -WithLoop: положить и ролик героя
```
Делает: ставит `?v=<хеш>` в ссылки → копия в `%TEMP%\rldev\sitepkg` (без downloads, data, cloud/test) →
вырезает комментарии из .js/.css/.html → ставит `?v=` заново → `node --check` →
`site-update.zip` (код, без видео) и `site-files.zip` (всё) в папку «Amethyx для сайта» на Рабочем столе.

Владелец заливает сам: ispmanager → папка сайта → загрузить zip → «Распаковать» с заменой → удалить zip,
больше ничего не удалять → Ctrl+F5. Обычно нужен только `site-update.zip`.

## Проверить
- Вид без PHP: `.claude/launch.json` → «website-mock» (`installer/site/mock-site.mjs`, порт 8821, выдуманные версии).
  Перед этим собрать тестовую копию в `%TEMP%\rldev\sitetest\www` теми же шагами, что и пакет.
- PHP-логика: `%TEMP%\rldev\php74\php.exe -n -l <файл>`; адрес посетителя —
  `php74 installer\site\client-ip-test.php website\lib\amethyx.php` (9 случаев).
- Полный тест API (`installer/site/api-test.mjs`) ждёт PHP-сервер на 8820 с тестовой копией; после поломки
  php 8.1 заново не запускался.
- Живой сайт, только чтение: `node installer/site/live-check.mjs`, `live-security.mjs` (без попыток входа),
  `live-downloads.mjs` (HEAD, скачивания не считаются).

## Правила
- В публичных файлах на сервере нет комментариев и подсказок про вход в админку (случай 2026-10-21).
- После правки .js/.css или картинок галереи — новые `?v=` (скрипт делает сам); хост кэширует сутки.
- Тексты версий для игроков — одна короткая строка; версии показываются как «1.7.1 beta 5».
- Коммит сайта — через `%TEMP%\rldev\commitmsg-site.txt` и `git commit -F … -- website/...`
  (A коммитит в ту же ветку main).
- Подробнее о решениях и ловушках — `docs/DECISIONS.md` (разделы «Сайт» и «Сервер Amethyx»).
