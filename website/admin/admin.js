/* Amethyx admin panel: login (or creating the admin on the first visit), statistics,
   versions with uploading in pieces, API tokens and the password. Talks to ../api.php. */
(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const PLATFORMS = { windows: 'Windows 10 / 11', 'windows-legacy': 'Windows 7 / 8', 'mac-arm64': 'macOS · Apple Silicon', 'mac-x64': 'macOS · Intel', linux: 'Linux' };
  const MESSAGES = {
    wrong: 'Неверный логин или пароль.',
    locked: 'Слишком много попыток. Подождите 15 минут.',
    password: 'Пароль — не меньше 10 символов.',
    login: 'Логин: 3–32 латинские буквы, цифры, _ . -',
    exists: 'Файл с таким именем уже есть на сайте. Удалите ту версию или переименуйте файл.',
    name: 'Нужен установщик или архив (.exe, .zip, .dmg…).',
    space: 'На хостинге не хватает места.',
    version: 'Укажите версию.',
    platform: 'Выберите платформу.',
    checksum: 'Файл повредился по дороге. Загрузите его ещё раз.',
    storage: 'Сервер не может записать файл. Проверьте права на папку сайта.',
    sqlite: 'На хостинге выключен pdo_sqlite. Включите его в настройках PHP сайта.',
  };

  async function api(action, { body, query = '', raw, signal } = {}) {
    const options = { method: body !== undefined || raw ? 'POST' : 'GET', headers: { 'X-Amethyx': '1' }, credentials: 'same-origin', signal };
    if (raw) { options.body = raw; options.headers['Content-Type'] = 'application/octet-stream'; }
    else if (body !== undefined) { options.body = JSON.stringify(body); options.headers['Content-Type'] = 'application/json'; }
    const res = await fetch(`../api.php?a=${action}${query}`, options);
    let data = {};
    try { data = await res.json(); } catch (e) { /* not JSON: PHP is missing or broke */ }
    if (!res.ok) {
      if (res.status === 401 && data.error === 'login') showAuth(false);
      const error = new Error(MESSAGES[data.error] || data.message || `Ошибка сервера (${res.status})`);
      error.code = data.error; error.status = res.status; error.data = data;
      throw error;
    }
    return data;
  }

  let toastTimer = 0;
  function toast(text) {
    const el = $('toast');
    el.textContent = text; el.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  const fmtNum = (n) => n.toLocaleString('ru-RU');
  const fmtSize = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
  const fmtDay = (iso) => { const [y, m, d] = iso.split('-'); return `${d}.${m}`; };
  const el = (tag, props = {}, ...kids) => {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => { if (k === 'class') node.className = v; else if (k.startsWith('on')) node.addEventListener(k.slice(2), v); else node.setAttribute(k, v); });
    kids.flat().forEach((kid) => kid != null && node.append(kid));
    return node;
  };

  // ---- Logging in -------------------------------------------------------------------------

  let setupMode = false;
  function showAuth(setup) {
    setupMode = setup;
    $('panel').hidden = true; $('logout').hidden = true; $('who').hidden = true;
    $('auth').hidden = false;
    $('auth-title').textContent = setup ? 'Создать админа' : 'Вход';
    $('auth-lead').textContent = setup
      ? 'Админа ещё нет. Придумайте логин и пароль — войти сможет только тот, кто их знает. Пароль хранится на сервере только в виде хэша.'
      : 'Только для владельца сайта.';
    $('auth-repeat').hidden = !setup;
    $('auth-form').password.autocomplete = setup ? 'new-password' : 'current-password';
    $('auth-submit').textContent = setup ? 'Создать и войти' : 'Войти';
    $('auth-form').login.focus();
  }

  function showPanel(login) {
    $('auth').hidden = true; $('panel').hidden = false;
    $('who').textContent = login; $('who').hidden = false; $('logout').hidden = false;
    openTab(location.hash.slice(1) || 'stats');
  }

  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    $('auth-error').textContent = '';
    if (setupMode && form.password.value !== form.repeat.value) { $('auth-error').textContent = 'Пароли не совпадают.'; return; }
    try {
      const data = await api(setupMode ? 'setup' : 'login', { body: { login: form.login.value.trim(), password: form.password.value } });
      form.reset();
      showPanel(data.admin);
    } catch (error) { $('auth-error').textContent = error.message; }
  });

  $('logout').addEventListener('click', async () => {
    try { await api('logout', { body: {} }); } catch (e) { /* signed out anyway */ }
    showAuth(false);
  });

  // ---- Tabs -------------------------------------------------------------------------------

  const loaders = { stats: loadStats, versions: loadVersions, tokens: loadTokens, account: loadLimits };
  function openTab(name) {
    if (!loaders[name]) name = 'stats';
    document.querySelectorAll('.adm__tabs [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.adm__tab').forEach((s) => { s.hidden = s.id !== `tab-${name}`; });
    history.replaceState(null, '', `#${name}`);
    loaders[name]().catch((error) => toast(error.message));
  }
  document.querySelectorAll('.adm__tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openTab(b.dataset.tab)));

  // ---- Statistics -------------------------------------------------------------------------

  const METRICS = [
    { key: 'view', title: 'Просмотры страницы' },
    { key: 'download', title: 'Скачивания' },
    { key: 'video', title: 'Просмотры видео со звуком' },
  ];

  async function loadStats() {
    const data = await api('stats', { query: `&days=${$('days').value}` });
    const sum = (key) => data.days.reduce((s, d) => s + d[key], 0);
    $('tiles').replaceChildren(...METRICS.map((m) => el('div', {},
      el('b', {}, fmtNum(sum(m.key))), el('span', {}, m.title), el('small', {}, `за всё время: ${fmtNum(data.totals[m.key])}`))));
    // One small chart per measure: they have very different sizes, so they never share an axis.
    $('charts').replaceChildren(...METRICS.map((m) => chart(m, data.days)));
    const head = el('tr', {}, el('th', {}, 'День'), ...METRICS.map((m) => el('th', {}, m.title)));
    const rows = data.days.slice().reverse().map((d) => el('tr', {}, el('td', {}, d.day), ...METRICS.map((m) => el('td', {}, fmtNum(d[m.key])))));
    $('stats-table').replaceChildren(el('thead', {}, head), el('tbody', {}, rows));
  }
  $('days').addEventListener('change', () => loadStats().catch((e) => toast(e.message)));

  function chart(metric, days) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 1000, H = 120, top = 8, bottom = 18;
    const max = Math.max(1, ...days.map((d) => d[metric.key]));
    const nice = niceMax(max);
    const step = W / days.length;
    const barW = Math.max(2, Math.min(22, step - 2));
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `${metric.title} по дням`);
    const y = (v) => top + (H - top - bottom) * (1 - v / nice);
    [0, nice / 2, nice].forEach((v) => {
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('class', 'grid'); line.setAttribute('x1', 0); line.setAttribute('x2', W);
      line.setAttribute('y1', y(v)); line.setAttribute('y2', y(v));
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(line);
    });
    days.forEach((d, i) => {
      const g = document.createElementNS(NS, 'g');
      const hit = document.createElementNS(NS, 'rect');
      hit.setAttribute('class', 'hit'); hit.setAttribute('x', i * step); hit.setAttribute('width', step);
      hit.setAttribute('y', 0); hit.setAttribute('height', H - bottom);
      const value = d[metric.key];
      const bar = document.createElementNS(NS, 'rect');
      const h = value ? Math.max(2, y(0) - y(value)) : 0;
      bar.setAttribute('class', 'bar'); bar.setAttribute('x', i * step + (step - barW) / 2); bar.setAttribute('width', barW);
      bar.setAttribute('y', y(0) - h); bar.setAttribute('height', h);
      g.append(hit, bar);
      g.addEventListener('mouseenter', () => { g.classList.add('is-hover'); showTip(`${fmtDay(d.day)}: <b>${fmtNum(value)}</b>`); });
      g.addEventListener('mousemove', moveTip);
      g.addEventListener('mouseleave', () => { g.classList.remove('is-hover'); $('tip').hidden = true; });
      svg.append(g);
    });
    const label = (text, x, anchor) => {
      const t = document.createElementNS(NS, 'text');
      t.setAttribute('class', 'axis'); t.setAttribute('x', x); t.setAttribute('y', H - 3); t.setAttribute('text-anchor', anchor);
      t.textContent = text; return t;
    };
    svg.append(label(fmtDay(days[0].day), 0, 'start'), label(fmtDay(days[days.length - 1].day), W, 'end'));
    return el('div', { class: 'adm__chart' }, el('h3', {}, metric.title, el('span', {}, `макс. ${fmtNum(max)} в день`)), svg);
  }

  function niceMax(v) {
    const p = 10 ** Math.floor(Math.log10(v));
    for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
    return 10 * p;
  }
  function showTip(html) { const tip = $('tip'); tip.innerHTML = html; tip.hidden = false; }
  function moveTip(event) { const tip = $('tip'); tip.style.left = `${event.clientX + 14}px`; tip.style.top = `${event.clientY - 34}px`; }

  // ---- Versions ---------------------------------------------------------------------------

  async function loadVersions() {
    const { versions } = await api('versions');
    if (!versions.length) { $('versions').replaceChildren(el('p', { class: 'adm__empty' }, 'Пока нет ни одной версии. Загрузите сборку выше.')); return; }
    $('versions').replaceChildren(...versions.map(versionCard));
  }

  function versionCard(v) {
    const act = (text, handler, cls = '') => el('button', { class: `btn btn--ghost ${cls}`, type: 'button', onclick: handler }, text);
    const update = async (fields, done) => { try { await api('version-update', { body: { id: v.id, ...fields } }); toast(done); loadVersions(); } catch (e) { toast(e.message); } };
    const tags = [
      v.latest && !v.hidden ? el('span', { class: 'adm__tag latest' }, 'последняя') : null,
      v.channel === 'beta' ? el('span', { class: 'adm__tag beta' }, 'бета') : null,
      v.hidden ? el('span', { class: 'adm__tag' }, 'скрыта') : null,
      v.missing ? el('span', { class: 'adm__tag warn' }, 'файла нет') : null,
    ];
    return el('article', { class: `adm__version${v.hidden ? ' is-hidden' : ''}` },
      el('div', {},
        el('h3', {}, `${v.version}`, el('span', { class: 'adm__tag' }, PLATFORMS[v.platform] || v.platform), ...tags),
        el('p', {}, `${v.date} · ${fmtSize(v.size)} · скачиваний: ${fmtNum(v.downloads)} · ${v.file}`),
        v.notes ? el('p', { class: 'notes' }, v.notes) : null),
      el('div', { class: 'adm__actions' },
        !v.latest || v.hidden ? act('Сделать последней', () => update({ latest: true }, 'Теперь кнопки «Скачать» дают эту версию')) : null,
        act(v.hidden ? 'Показать' : 'Скрыть', () => update({ hidden: !v.hidden }, v.hidden ? 'Версия снова видна' : 'Версия скрыта')),
        act(v.channel === 'beta' ? 'Не бета' : 'Бета', () => update({ channel: v.channel === 'beta' ? 'release' : 'beta' }, 'Готово')),
        act('Что нового', () => {
          const notes = prompt(`Что нового в ${v.version}:`, v.notes);
          if (notes !== null) update({ notes }, 'Текст сохранён');
        }),
        act('Удалить', async () => {
          if (!confirm(`Удалить ${v.version} (${PLATFORMS[v.platform] || v.platform}) вместе с файлом ${v.file}? Это не отменить.`)) return;
          try { await api('version-delete', { body: { id: v.id } }); toast('Версия удалена'); loadVersions(); } catch (e) { toast(e.message); }
        }, 'danger')));
  }

  $('import').addEventListener('click', async () => {
    try { const { added } = await api('import', { body: {} }); toast(added ? `Добавлено файлов: ${added}` : 'Новых файлов нет'); loadVersions(); } catch (e) { toast(e.message); }
  });

  // Upload: the file goes in pieces small enough for the hosting, so size limits don't matter.
  const drop = $('drop');
  const fileInput = $('upload-file');
  let uploading = null;
  function pickFile(file) {
    if (!file) return;
    const dt = new DataTransfer(); dt.items.add(file); fileInput.files = dt.files;
    $('drop-text').textContent = `${file.name} · ${fmtSize(file.size)}`;
    const version = file.name.match(/(\d+\.\d+(?:\.\d+)?(?:-(?:alpha|beta|rc|pre)[0-9A-Za-z.]*?)?)(?=\.(?:exe|zip|dmg|msi|msix|appimage|deb|rpm)$|-(?:mac|win|linux|arm64|x64))/i);
    if (version && !$('upload-version').value) $('upload-version').value = version[1];
    $('upload-beta').checked = /beta/i.test(version ? version[1] : file.name);
  }
  fileInput.addEventListener('change', () => pickFile(fileInput.files[0]));
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('is-over')));
  drop.addEventListener('drop', (e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); });

  async function sha256(file) {
    try { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, '0')).join(''); }
    catch (e) { return ''; } // not enough memory or no HTTPS: the size check still guards the upload
  }

  $('upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = fileInput.files[0];
    $('upload-error').textContent = '';
    if (!file) { $('upload-error').textContent = 'Выберите файл.'; return; }
    const bar = $('upload-progress'); const fill = bar.firstElementChild;
    const controller = new AbortController();
    uploading = { controller, id: null };
    $('upload-submit').disabled = true; $('upload-cancel').hidden = false; bar.hidden = false; fill.style.width = '0%';
    try {
      const start = await api('upload-start', { body: {
        name: file.name, size: file.size, version: $('upload-version').value.trim(), platform: $('upload-platform').value,
        channel: $('upload-beta').checked ? 'beta' : 'release', notes: $('upload-notes').value, latest: $('upload-latest').checked,
      } });
      uploading.id = start.id;
      const hash = sha256(file);
      let offset = 0;
      while (offset < file.size) {
        let tries = 0;
        for (;;) {
          try {
            const res = await api('upload-chunk', { query: `&id=${start.id}&offset=${offset}`, raw: file.slice(offset, offset + start.chunk), signal: controller.signal });
            offset = res.received; break;
          } catch (error) {
            if (error.name === 'AbortError') throw error;
            if (error.status === 409 && error.data && typeof error.data.received === 'number') { offset = error.data.received; break; }
            if (++tries >= 5) throw error;
            await new Promise((r) => setTimeout(r, 1500 * tries)); // a hiccup in the connection: try the piece again
          }
        }
        fill.style.width = `${Math.round((offset / file.size) * 100)}%`;
      }
      await api('upload-finish', { body: { id: start.id, sha256: await hash } });
      toast('Сборка загружена');
      event.target.reset(); $('drop-text').textContent = 'Перетащите файл сюда или нажмите, чтобы выбрать'; $('upload-latest').checked = true;
      loadVersions();
    } catch (error) {
      if (error.name === 'AbortError') toast('Загрузка отменена');
      else $('upload-error').textContent = error.message;
      if (uploading.id) api('upload-cancel', { body: { id: uploading.id } }).catch(() => {});
    } finally {
      uploading = null;
      $('upload-submit').disabled = false; $('upload-cancel').hidden = true; bar.hidden = true;
    }
  });
  $('upload-cancel').addEventListener('click', () => { if (uploading) uploading.controller.abort(); });
  window.addEventListener('beforeunload', (e) => { if (uploading) { e.preventDefault(); e.returnValue = ''; } });

  // ---- Tokens ------------------------------------------------------------------------------

  async function loadTokens() {
    const { tokens } = await api('tokens');
    $('tokens').replaceChildren(...(tokens.length ? tokens.map((t) => el('div', { class: 'adm__token' },
      el('p', {}, t.name, ' ', el('small', {}, `создан ${t.created}${t.used ? ` · последний раз ${t.used}` : ' · ещё не использовался'}`)),
      el('button', { class: 'btn btn--ghost adm__small', type: 'button', onclick: async () => {
        if (!confirm(`Удалить токен «${t.name}»? Скрипты с ним перестанут работать.`)) return;
        try { await api('token-delete', { body: { id: t.id } }); loadTokens(); } catch (e) { toast(e.message); }
      } }, 'Удалить'))) : [el('p', { class: 'adm__empty' }, 'Токенов нет.')]));
  }
  $('token-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const { token } = await api('token-create', { body: { name: $('token-name').value.trim() } });
      $('token-value').textContent = token; $('token-new').hidden = false; $('token-name').value = '';
      loadTokens();
    } catch (e) { toast(e.message); }
  });
  $('token-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText($('token-value').textContent); toast('Скопировано'); } catch (e) { toast('Выделите токен и скопируйте вручную'); }
  });

  // ---- Password ----------------------------------------------------------------------------

  $('password-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    $('password-error').textContent = '';
    if (form.new.value !== form.repeat.value) { $('password-error').textContent = 'Новые пароли не совпадают.'; return; }
    try { await api('password', { body: { old: form.old.value, new: form.new.value } }); form.reset(); toast('Пароль изменён'); }
    catch (e) { $('password-error').textContent = e.message; }
  });

  async function loadLimits() {
    const l = await api('limits');
    $('limits').textContent = `PHP ${l.php} · кусок загрузки ${fmtSize(l.chunk)} · свободно на диске ${l.free_space ? fmtSize(l.free_space) : '?'} · база ${l.data_outside_site ? 'вне папки сайта' : 'в папке сайта (data, закрыта .htaccess)'}`;
  }

  // ---- Start ---------------------------------------------------------------------------------

  api('me').then((me) => (me.admin ? showPanel(me.admin) : showAuth(me.setup))).catch((error) => {
    showAuth(false);
    $('auth-error').textContent = error.status ? error.message : 'Сервер не отвечает: на хостинге должен работать PHP.';
  });
})();
