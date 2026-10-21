/* Amethyx Launcher website: Russian / English switch (remembered), the mobile menu, a lightbox for
   the screenshots, blocks that appear while scrolling and the launcher window leaning to the mouse. */
(function () {
  'use strict';

  var EN = {
    'nav.features': 'Features',
    'nav.shots': 'Screenshots',
    'nav.download': 'Download',
    'nav.faq': 'FAQ',
    'hero.subtitle': 'A Minecraft launcher with mods, skins and friends — beautiful, fast and free.',
    'hero.download': 'Download for Windows',
    'hero.get': 'Download',
    'hero.source': 'Source code on GitHub',
    'hero.free': 'free',
    'video.watch': 'Watch with sound',
    'features.title': 'What it does',
    'features.lead': 'Everything you need to play with mods and friends — in one window.',
    'f1.title': 'Easy instances',
    'f1.text': 'An instance with any mod loader in a couple of clicks, your own groups and notes. Instances from other launchers move over by themselves — with mods, worlds and settings.',
    'f2.title': 'A huge mod library',
    'f2.text': 'Modpacks, mods, resource packs and shaders in one place. The launcher installs everything they need, checks compatibility and backs up your worlds before updates.',
    'f3.title': 'One-click optimization',
    'f3.text': 'The launcher studies your PC and the instance, adds FPS mods and picks the settings. Don’t like it — everything goes back with one button.',
    'f4.title': 'Skins and a living player',
    'f4.text': 'Your player in 3D on the home screen: follows the mouse, waves and dances. A wardrobe for several skins; a new skin goes on in one click.',
    'f5.title': 'Friends and chat',
    'f5.text': 'Who is online and what they play, messages and screenshots. A friend joins your world with one button, and the launcher builds the right instance for them.',
    'f6.title': 'Your own server',
    'f6.text': 'A server from your instance in a couple of clicks — on your own PC, and soon in the cloud. Or a ready pack for any hosting.',
    'f7.title': 'Fast and always fresh',
    'f7.text': 'Files download in several streams, all mods update at once. And the launcher keeps itself up to date too.',
    'f8.title': 'Beautiful and clear',
    'f8.text': 'The amethyst pixel style, lively animations, panoramas and sounds. A short tour for newcomers and several languages to choose from.',
    'shots.title': 'Screenshots',
    'shots.mods': 'Instance mods',
    'shots.library': 'Modrinth and CurseForge library',
    'shots.wardrobe': 'Skin wardrobe',
    'shots.friends': 'Friends and chat',
    'shots.servers': 'Server for hosting',
    'shots.home': 'Home screen',
    'download.title': 'Download Amethyx',
    'step1': 'Download and run the installer',
    'step2': 'Add an account: Microsoft, Ely.by or offline',
    'step3': 'Create an instance or install a modpack — and play',
    'download.all': 'All versions on GitHub',
    'download.changes': 'What’s new',
    'faq.title': 'FAQ',
    'q1': 'Do I need a Minecraft license?',
    'a1': 'No. You can play offline or with Ely.by. Servers that check for a license need a Microsoft account.',
    'q2': 'Is it safe?',
    'a2': 'The launcher’s code is open on GitHub. Passwords are typed only on the official Microsoft and Ely.by sites — the launcher never sees them.',
    'q3': 'Where do the mods come from?',
    'a3': 'From Modrinth and CurseForge — the same sites every major launcher uses. The launcher checks dependencies and compatibility itself.',
    'q4': 'How do I update the launcher?',
    'a4': 'You don’t — it updates itself: it downloads the new version and offers to install it with one button.',
    'q5': 'Can I bring instances from another launcher?',
    'a5': 'Yes: Prism, ElyPrism, Modrinth App, CurseForge, TLauncher, Millida and others are found automatically — mods, settings, worlds and screenshots move over whole.',
    'footer.note': 'Amethyx Launcher is an unofficial launcher. Not affiliated with or endorsed by Mojang Studios or Microsoft. Minecraft is a trademark of Mojang Studios.'
  };

  var STORE_KEY = 'amethyx.site.lang';
  var version = '1.7'; // replaced by the latest Windows build from the admin panel (api.php)
  // "1.7-beta.28" reads as "1.7 beta 28".
  function versionText(raw) { return String(raw).replace(/-beta\.(\d+)$/, ' beta $1'); }
  var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-i18n]'));
  var russian = {};
  nodes.forEach(function (node) { russian[node.getAttribute('data-i18n')] = node.textContent; });
  var titleRu = document.title;
  var descriptionMeta = document.querySelector('meta[name="description"]');
  var descriptionRu = descriptionMeta ? descriptionMeta.content : '';

  function savedLanguage() {
    try {
      var saved = localStorage.getItem(STORE_KEY);
      if (saved === 'ru' || saved === 'en') return saved;
    } catch (error) { /* storage can be blocked */ }
    var browser = (navigator.language || 'ru').toLowerCase();
    return /^(ru|uk|be|kk)/.test(browser) ? 'ru' : 'en';
  }

  function applyLanguage(language) {
    var english = language === 'en';
    nodes.forEach(function (node) {
      var key = node.getAttribute('data-i18n');
      node.textContent = english && EN[key] ? EN[key] : russian[key];
    });
    document.documentElement.lang = language;
    document.title = english ? 'Amethyx Launcher — a Minecraft launcher with mods, skins and friends' : titleRu;
    if (descriptionMeta) {
      descriptionMeta.content = english
        ? 'A free Minecraft: Java Edition launcher for Windows. Modded instances, Modrinth and CurseForge, a skin wardrobe, friends and chat, your own server, one-click optimization.'
        : descriptionRu;
    }
    document.getElementById('version-line').textContent = (english ? 'Version ' : 'Версия ') + versionText(version);
    document.getElementById('changelog-link').href =
      'https://github.com/VanillaPlusLauncher/VanillaPlus/blob/main/' + (english ? 'CHANGELOG.md' : 'CHANGELOG.ru.md');
    var lang = document.getElementById('lang');
    lang.textContent = english ? 'RU' : 'EN';
    lang.title = english ? 'Русский' : 'English';
    document.getElementById('burger').setAttribute('aria-label', english ? 'Menu' : 'Меню');
    Array.prototype.forEach.call(document.querySelectorAll('.lightbox__close'), function (button) {
      button.setAttribute('aria-label', english ? 'Close' : 'Закрыть');
    });
    document.getElementById('video-open').setAttribute('aria-label', english ? 'Watch the video with sound' : 'Смотреть видео со звуком');
    renderDownloads();
  }

  // ---- Downloads: the visitor's system, its newest build, and every other version ----------
  // The big button gives the newest build for the system the visitor is on; "Other versions"
  // opens every build from the admin panel, grouped by system, to go back to a release or try a beta.
  var site = null; // api.php?a=site: { latest: { platform: version }, versions: [newest first] }
  // windows-legacy is the build for Windows 7, 8 and Windows 10 older than 1803: the regular
  // installer does not start there.
  var SYSTEMS = ['windows', 'windows-legacy', 'mac-arm64', 'mac-x64', 'linux'];
  var SYSTEM_NAMES = { windows: 'Windows', 'windows-legacy': 'Windows 7 / 8 / старая 10', 'mac-arm64': 'macOS (Apple Silicon)', 'mac-x64': 'macOS (Intel)', linux: 'Linux' };
  var SYSTEM_SHORT = { windows: 'Windows', 'windows-legacy': 'Windows 7 / 8', 'mac-arm64': 'macOS', 'mac-x64': 'macOS', linux: 'Linux' };
  var DL_TEXT = {
    ru: {
      downloadFor: 'Скачать для ', download: 'Скачать', latest: 'последняя',
      more: 'Другие версии', less: 'Скрыть версии', mb: ' МБ', none: 'Для этой системы версий пока нет.',
      lead: { windows: 'Установщик для Windows. Дальше лаунчер обновляется сам.', 'windows-legacy': 'Установщик для Windows 7, 8 и Windows 10 до версии 1803. Дальше лаунчер обновляется сам.', mac: 'Сборка для macOS — пока бета, новые версии ставятся вручную.', linux: 'Сборка для Linux.' },
      mobile: 'Amethyx работает на компьютере с Windows или macOS — скачайте его там.',
      noBuild: 'Для вашей системы сборки пока нет — вот версия для Windows.',
      noWin7: 'Для Windows 7, 8 и Windows 10 до версии 1803 сборки пока нет. Версия ниже работает только на Windows 10 (1803 и новее) и 11.',
      win10: 'Windows 10 / 11',
      legacyTab: 'Windows 7 / 8 / старая 10', legacyShort: 'старой Windows',
      req: {
        windows: 'Windows 10 (версия 1803 и новее) или Windows 11, 64 бита. Для Windows 7, 8 и Windows 10 старше 1803 — отдельная сборка в «Других версиях». Java лаунчер скачает сам.',
        'windows-legacy': 'Windows 7 (SP1), 8, 8.1 или Windows 10 до версии 1803. Java лаунчер скачает сам.',
        mac: 'Java лаунчер скачает сам.',
        linux: 'Java лаунчер скачает сам.'
      },
      macTitle: 'Как установить на Mac',
      macSteps: [
        'Распакуйте zip двойным кликом и перетащите Amethyx.app в «Программы».',
        'Сборка не подписана у Apple (это платно), поэтому при первом запуске macOS скажет «не удаётся проверить» или «повреждено». Один раз откройте «Терминал» и выполните:',
        'Если после этого всё равно не открывается, выполните ещё одну команду и снова запустите Amethyx:'
      ],
      copy: 'Скопировать', copied: 'Скопировано'
    },
    en: {
      downloadFor: 'Download for ', download: 'Download', latest: 'latest',
      more: 'Other versions', less: 'Hide versions', mb: ' MB', none: 'No versions for this system yet.',
      lead: { windows: 'An installer for Windows. After that the launcher updates itself.', 'windows-legacy': 'An installer for Windows 7, 8 and Windows 10 older than 1803. After that the launcher updates itself.', mac: 'A build for macOS — still a beta, new versions are installed by hand.', linux: 'A build for Linux.' },
      mobile: 'Amethyx runs on a Windows or macOS computer — download it there.',
      noBuild: 'There is no build for your system yet — here is the Windows version.',
      noWin7: 'There is no build for Windows 7, 8 and Windows 10 older than 1803 yet. The version below runs on Windows 10 (1803 or newer) and 11 only.',
      win10: 'Windows 10 / 11',
      legacyTab: 'Windows 7 / 8 / old 10', legacyShort: 'older Windows',
      req: {
        windows: 'Windows 10 (version 1803 or newer) or Windows 11, 64-bit. For Windows 7, 8 and Windows 10 older than 1803 there is a separate build under Other versions. The launcher downloads Java by itself.',
        'windows-legacy': 'Windows 7 (SP1), 8, 8.1 or Windows 10 older than 1803. The launcher downloads Java by itself.',
        mac: 'The launcher downloads Java by itself.',
        linux: 'The launcher downloads Java by itself.'
      },
      macTitle: 'How to install on a Mac',
      macSteps: [
        'Unpack the zip with a double click and drag Amethyx.app into Applications.',
        'The build is not signed by Apple (that costs money), so on the first start macOS says it “cannot be verified” or is “damaged”. Open Terminal once and run:',
        'If it still does not open, run one more command and start Amethyx again:'
      ],
      copy: 'Copy', copied: 'Copied'
    }
  };
  // The commands of the Mac guide (the same in every language).
  var MAC_COMMANDS = [null, 'xattr -cr /Applications/Amethyx.app', 'codesign --force --deep --sign - /Applications/Amethyx.app'];

  // The Mac guide: shown when the big button gives a Mac build, or the macOS tab of
  // "Other versions" is open.
  function renderMacHelp(T, show) {
    var box = document.getElementById('mac-help');
    box.hidden = !show;
    if (!show) return;
    while (box.firstChild) box.removeChild(box.firstChild);
    box.appendChild(makeEl('h3', 'mac-help__title', T.macTitle));
    var steps = makeEl('ol', 'mac-help__steps');
    T.macSteps.forEach(function (text, index) {
      var step = makeEl('li');
      step.appendChild(makeEl('p', '', text));
      var command = MAC_COMMANDS[index];
      if (command) {
        var line = makeEl('div', 'mac-help__command');
        line.appendChild(makeEl('code', '', command));
        var copy = makeEl('button', 'btn btn--ghost mac-help__copy', T.copy);
        copy.type = 'button';
        copy.addEventListener('click', function () {
          var done = function () { copy.textContent = T.copied; setTimeout(function () { copy.textContent = T.copy; }, 1600); };
          if (navigator.clipboard) navigator.clipboard.writeText(command).then(done, function () {});
        });
        line.appendChild(copy);
        step.appendChild(line);
      }
      steps.appendChild(step);
    });
    box.appendChild(steps);
  }

  // Which computer the visitor is on. Phones and tablets get "mobile".
  function detectSystem() {
    var ua = navigator.userAgent || '';
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    if (/Android|iPhone|iPad|iPod/i.test(ua) || (/Mac/i.test(platform) && navigator.maxTouchPoints > 1)) return 'mobile';
    if (/Windows NT 6\.[123]/.test(ua)) return 'windows-legacy'; // Windows 7, 8, 8.1
    if (/Win/i.test(platform) || /Windows/i.test(ua)) return 'windows';
    if (/Mac/i.test(platform) || /Mac OS X/i.test(ua)) return macChip();
    if (/Linux|X11/i.test(platform + ua)) return 'linux';
    return 'windows';
  }
  // Apple Silicon or Intel: browsers don't say it outright, but the graphics chip's name does
  // ("Apple M1…" / "Apple GPU" against Intel, AMD or NVIDIA). Unknown means Apple Silicon:
  // every new Mac has it, and an Intel build would still run there.
  function macChip() {
    try {
      var gl = document.createElement('canvas').getContext('webgl');
      var info = gl && gl.getExtension('WEBGL_debug_renderer_info');
      var renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      var lose = gl && gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      if (/Intel|AMD|Radeon|NVIDIA/i.test(renderer)) return 'mac-x64';
    } catch (error) { /* no WebGL: keep the default */ }
    return 'mac-arm64';
  }
  var detected = detectSystem();
  // ?os=mac-arm64 (or windows, windows-legacy, mac-x64, linux, mobile) shows the page as on that system.
  var osParam = /[?&]os=([a-z0-9-]+)/.exec(location.search);
  if (osParam && (SYSTEMS.indexOf(osParam[1]) >= 0 || osParam[1] === 'mobile')) detected = osParam[1];
  // Chrome and Edge on a Mac can name the processor too.
  if (!osParam && /^mac/.test(detected) && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['architecture']).then(function (values) {
      if (values.architecture === 'arm') detected = 'mac-arm64';
      else if (values.architecture === 'x86') detected = 'mac-x64';
      chosenSystem = null;
      renderDownloads();
    }).catch(function () {});
  }
  // Windows 10 older than 1803 (the regular build needs 1803) looks like any Windows 10 in the user
  // agent; Chrome and Edge tell the release: platformVersion 1-5 is 1507-1709, 6 is 1803.
  if (!osParam && detected === 'windows' && navigator.userAgentData && navigator.userAgentData.getHighEntropyValues) {
    navigator.userAgentData.getHighEntropyValues(['platformVersion']).then(function (values) {
      var major = parseInt(values.platformVersion, 10);
      if (major >= 1 && major < 6) { detected = 'windows-legacy'; chosenSystem = null; renderDownloads(); }
    }).catch(function () {});
  }
  var chosenSystem = null; // the system open in "Other versions"

  // The system the big button serves: the visitor's own when there is a build for it
  // (an Intel build also runs on Apple Silicon), otherwise Windows.
  function mainSystem() {
    var latest = (site && site.latest) || {};
    var order = detected === 'mac-arm64' ? ['mac-arm64', 'mac-x64'] : [detected];
    for (var i = 0; i < order.length; i++) if (latest[order[i]]) return order[i];
    return 'windows';
  }

  function makeEl(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }
  function sizeText(bytes, T) { return Math.round(bytes / 1048576) + T.mb; }
  function dateText(iso) { return iso.split('-').reverse().join('.'); }

  function renderDownloads() {
    var lead = document.getElementById('dl-lead');
    if (!lead) return;
    var english = document.documentElement.lang === 'en';
    var T = DL_TEXT[english ? 'en' : 'ru'];
    var system = mainSystem();
    var group = /^mac/.test(system) ? 'mac' : system;
    var main = site && site.latest ? site.latest[system] : null;

    var noWin7 = detected === 'windows-legacy' && system !== 'windows-legacy';
    lead.textContent = detected === 'mobile' ? T.mobile
      : noWin7 ? T.noWin7
      : (site && system !== detected && !(detected === 'mac-arm64' && system === 'mac-x64')) ? T.noBuild
      : T.lead[group];
    document.getElementById('dl-req').textContent = T.req[group];
    var button = document.getElementById('download-second');
    button.href = main ? main.url : 'dl.php?platform=' + system;
    document.getElementById('dl-label').textContent = T.downloadFor + (noWin7 ? T.win10 : system === 'windows-legacy' ? T.legacyShort : SYSTEM_SHORT[system]);
    document.getElementById('dl-version').textContent = main
      ? versionText(main.version) + ' · ' + sizeText(main.size, T)
      : '';

    var versions = (site && site.versions) || [];
    var more = document.getElementById('dl-more');
    var picker = document.getElementById('dl-picker');
    more.hidden = !versions.length;
    document.getElementById('dl-more-text').textContent = picker.hidden ? T.more : T.less;
    renderMacHelp(T, group === 'mac');
    if (!versions.length) return;

    // System tabs: one per system that has builds. The Windows 7 / 8 / old 10 build is no tab of
    // its own: it sits in the Windows tab with its tag. The main system is open first.
    var tabOf = function (platform) { return platform === 'windows-legacy' ? 'windows' : platform; };
    var present = SYSTEMS.filter(function (s) {
      return s !== 'windows-legacy' && versions.some(function (v) { return tabOf(v.platform) === s; });
    });
    if (!chosenSystem || present.indexOf(chosenSystem) < 0) chosenSystem = present.indexOf(tabOf(system)) >= 0 ? tabOf(system) : present[0];
    if (group !== 'mac' && !picker.hidden && /^mac/.test(chosenSystem)) renderMacHelp(T, true);
    var tabs = document.getElementById('dl-systems');
    while (tabs.firstChild) tabs.removeChild(tabs.firstChild);
    tabs.hidden = present.length < 2;
    present.forEach(function (s) {
      var tab = makeEl('button', 'picker__system', SYSTEM_NAMES[s]);
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(s === chosenSystem));
      tab.addEventListener('click', function () { chosenSystem = s; renderDownloads(); });
      tabs.appendChild(tab);
    });

    var list = document.getElementById('versions-list');
    while (list.firstChild) list.removeChild(list.firstChild);
    var latestIds = SYSTEMS.map(function (s) { return site.latest[s] ? site.latest[s].id : null; });
    var shown = versions.filter(function (v) { return tabOf(v.platform) === chosenSystem; });
    if (!shown.length) list.appendChild(makeEl('li', 'versions__empty', T.none));    shown.forEach(function (v) {
      var item = makeEl('li');
      var head = makeEl('div', 'versions__head');
      head.appendChild(makeEl('b', '', versionText(v.version)));
      if (v.platform === 'windows-legacy') head.appendChild(makeEl('span', 'versions__tag', T.legacyTab));
      if (latestIds.indexOf(v.id) >= 0) head.appendChild(makeEl('span', 'versions__tag is-latest', T.latest));
      head.appendChild(makeEl('span', 'versions__meta', dateText(v.date) + ' · ' + sizeText(v.size, T)));
      var link = makeEl('a', 'btn btn--ghost versions__get');
      link.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 19h16" /></svg>';
      link.appendChild(document.createTextNode(T.download));
      link.href = v.url;
      head.appendChild(link);
      item.appendChild(head);
      if (v.notes) item.appendChild(makeEl('p', 'versions__notes', v.notes));
      list.appendChild(item);
    });
  }

  var language = savedLanguage();
  applyLanguage(language);
  document.getElementById('lang').addEventListener('click', function () {
    language = language === 'ru' ? 'en' : 'ru';
    try { localStorage.setItem(STORE_KEY, language); } catch (error) { /* not remembered then */ }
    applyLanguage(language);
  });

  // Mobile menu.
  var burger = document.getElementById('burger');
  var nav = document.getElementById('nav');
  function setMenu(open) {
    nav.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', String(open));
  }
  burger.addEventListener('click', function () { setMenu(!nav.classList.contains('is-open')); });
  nav.addEventListener('click', function (event) { if (event.target.closest('a')) setMenu(false); });

  // Lightbox for the screenshots.
  var lightbox = document.getElementById('lightbox');
  var lightboxImage = lightbox.querySelector('img');
  function closeLightbox() { lightbox.hidden = true; lightboxImage.removeAttribute('src'); }
  Array.prototype.forEach.call(document.querySelectorAll('.shot[data-full]'), function (shot) {
    shot.addEventListener('click', function () {
      lightboxImage.src = shot.getAttribute('data-full');
      lightboxImage.alt = shot.textContent.trim();
      lightbox.hidden = false;
    });
  });
  lightbox.addEventListener('click', function (event) { if (event.target !== lightboxImage) closeLightbox(); });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { closeLightbox(); setMenu(false); }
  });

  // Blocks appear softly as they scroll into view, one after another.
  var revealing = Array.prototype.slice.call(document.querySelectorAll('.reveal'));
  // Once a block is in place it drops the reveal styles so its own hover animations work again.
  function settle(node, after) {
    setTimeout(function () {
      node.classList.remove('reveal', 'is-in');
      node.style.transitionDelay = '';
    }, after);
  }
  if ('IntersectionObserver' in window) {
    var observer = new IntersectionObserver(function (entries) {
      var shown = 0;
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.style.transitionDelay = Math.min(shown, 6) * 70 + 'ms';
        entry.target.classList.add('is-in');
        observer.unobserve(entry.target);
        settle(entry.target, Math.min(shown, 6) * 70 + 750);
        shown += 1;
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
    revealing.forEach(function (node) { observer.observe(node); });
  } else {
    revealing.forEach(function (node) { node.classList.add('is-in'); });
  }

  // The trailer: the hero window plays a silent loop; a click opens the trailer large, with sound
  // (a little quieter than full volume). Small screens get the lighter 720p file. Closing pauses it.
  var player = document.getElementById('player');
  var playerVideo = player.querySelector('video');
  var FULL_VIDEO = Math.max(screen.width, screen.height) * (window.devicePixelRatio || 1) < 1600
    ? 'assets/video/trailer-720p.mp4' : 'assets/video/trailer-1080p.mp4';
  function closePlayer() {
    if (player.hidden) return;
    playerVideo.pause();
    player.hidden = true;
  }
  document.getElementById('video-open').addEventListener('click', function () {
    if (!playerVideo.getAttribute('src')) playerVideo.src = FULL_VIDEO;
    player.hidden = false;
    playerVideo.muted = false;
    playerVideo.volume = 0.6;
    var started = playerVideo.play();
    if (started && started.catch) started.catch(function () { /* the controls are there to start it */ });
    hit('video');
  });
  player.addEventListener('click', function (event) { if (event.target !== playerVideo) closePlayer(); });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') closePlayer(); });
  // Calm mode: the silent video stands still on its first picture.
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    Array.prototype.forEach.call(document.querySelectorAll('.window__video video'), function (video) {
      video.removeAttribute('autoplay');
      video.pause();
    });
  }

  // ---- The site's server (api.php): latest builds and visit counters ----
  // Without PHP (a plain preview) all of this quietly does nothing and the page still works.

  // Counters keep only numbers per day; a page view is counted once per visit.
  function hit(kind) {
    var body = JSON.stringify({ kind: kind });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('api.php?a=hit', body)) return;
      fetch('api.php?a=hit', { method: 'POST', body: body, keepalive: true }).catch(function () {});
    } catch (error) { /* counting is optional */ }
  }
  try {
    if (!sessionStorage.getItem('amethyx.viewed')) { sessionStorage.setItem('amethyx.viewed', '1'); hit('view'); }
  } catch (error) { hit('view'); }

  // The version line and the download section follow the admin panel.
  if (window.fetch) {
    fetch('api.php?a=site').then(function (res) { return res.ok ? res.json() : null; }).then(function (data) {
      if (!data || !data.latest) return;
      site = data;
      if (site.latest.windows) version = site.latest.windows.version;
      applyLanguage(language);
    }).catch(function () { /* no server: keep the defaults */ });
  }
  document.getElementById('dl-more').addEventListener('click', function () {
    var picker = document.getElementById('dl-picker');
    picker.hidden = !picker.hidden;
    this.setAttribute('aria-expanded', String(!picker.hidden));
    renderDownloads();
  });

  // The logo in the top bar takes you to the very top (the bar is sticky, so "#top" alone
  // would not move the page); the hero's Download button glides down to the download section.
  var scrollBehavior = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
  document.querySelector('.brand').addEventListener('click', function (event) {
    event.preventDefault();
    window.scrollTo({ top: 0, behavior: scrollBehavior });
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    setMenu(false);
  });
  document.getElementById('download-main').addEventListener('click', function (event) {
    event.preventDefault();
    document.getElementById('download').scrollIntoView({ behavior: scrollBehavior, block: 'start' });
    history.replaceState(null, '', '#download');
  });

  // The launcher's start screen in miniature: the turning amethyst geode (geode.js).
  if (window.AmethyxGeode) window.AmethyxGeode.start(document.getElementById('puzzle'));

  // The launcher window in the hero leans gently towards the mouse.
  var heroWindow = document.getElementById('hero-window');
  var canHover = window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  var calm = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (heroWindow && canHover && !calm) {
    var frame = 0;
    document.addEventListener('mousemove', function (event) {
      if (frame) return;
      frame = requestAnimationFrame(function () {
        frame = 0;
        var x = event.clientX / window.innerWidth - 0.5;
        var y = event.clientY / window.innerHeight - 0.5;
        heroWindow.style.setProperty('--ry', (-6 + x * 8).toFixed(2) + 'deg');
        heroWindow.style.setProperty('--rx', (3 - y * 6).toFixed(2) + 'deg');
      });
    });
  }
})();
