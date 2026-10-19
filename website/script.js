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
    'hero.source': 'Source code on GitHub',
    'hero.free': 'free',
    'features.title': 'What it does',
    'features.lead': 'Everything you need to play with mods and friends — in one window.',
    'f1.title': 'Instances like in Prism',
    'f1.text': 'Fabric, Forge, NeoForge and Quilt, drag-and-drop groups. Instances from Prism, CurseForge, Modrinth App, TLauncher and other launchers move over by themselves.',
    'f2.title': 'Mods from Modrinth and CurseForge',
    'f2.text': 'Modpacks, mods, resource packs, shaders and datapacks. Dependencies install themselves; files download in parallel and in parts, like in a browser.',
    'f3.title': 'One-click optimization',
    'f3.text': 'The launcher looks at your PC and the instance, adds FPS mods, picks memory and graphics settings. Everything can be undone with one button.',
    'f4.title': 'Skin wardrobe',
    'f4.text': 'Five skin slots, a 3D carousel, skins from PNG, by nickname, from The Skindex and NameMC — a downloaded skin shows up in the launcher by itself.',
    'f5.title': 'Friends and chat',
    'f5.text': 'Who is online and what they play, messages and screenshots. A friend joins your world with one button — no public IP or router setup.',
    'f6.title': 'Your own server',
    'f6.text': 'A server from your instance in one click, export for any hosting (ZIP or folder, client-only mods are filtered out) and a server list with ping.',
    'f7.title': 'One-click updates',
    'f7.text': 'The launcher finds new versions of your mods and updates them all at once. And it keeps itself up to date too.',
    'f8.title': 'Beautiful and in your language',
    'f8.text': 'Panoramas from different game versions, sounds, the amethyst style and animations. Seven languages; Microsoft, Ely.by and offline accounts.',
    'shots.title': 'Screenshots',
    'shots.mods': 'Instance mods',
    'shots.library': 'Modrinth and CurseForge library',
    'shots.wardrobe': 'Skin wardrobe',
    'shots.friends': 'Friends and chat',
    'shots.servers': 'Server for hosting',
    'shots.home': 'Home screen',
    'download.title': 'Download Amethyx',
    'download.lead': 'An installer for Windows. After that the launcher updates itself.',
    'step1': 'Download and run the installer',
    'step2': 'Add an account: Microsoft, Ely.by or offline',
    'step3': 'Create an instance or install a modpack — and play',
    'download.req': 'Windows 10 (1803 or newer) or Windows 11, 64-bit. The launcher downloads Java by itself.',
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
  var VERSION = '1.7.0';
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
    document.getElementById('version-line').textContent = (english ? 'Version ' : 'Версия ') + VERSION;
    document.getElementById('changelog-link').href =
      'https://github.com/VanillaPlusLauncher/VanillaPlus/blob/main/' + (english ? 'CHANGELOG.md' : 'CHANGELOG.ru.md');
    var lang = document.getElementById('lang');
    lang.textContent = english ? 'RU' : 'EN';
    lang.title = english ? 'Русский' : 'English';
    document.getElementById('burger').setAttribute('aria-label', english ? 'Menu' : 'Меню');
    document.querySelector('.lightbox__close').setAttribute('aria-label', english ? 'Close' : 'Закрыть');
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

  // The launcher's start screen in miniature: a sliding-block puzzle of amethyst cubes on a 3 × 3
  // board, one place free; every moment a cube next to the gap slides into it.
  (function puzzle() {
    var row = document.getElementById('puzzle');
    if (!row) return;
    var SIDE = 3;
    var CELL = 30;
    var shades = ['#57409a', '#6a4fbb', '#7d5ed8', '#9576f0', '#ae93ff'];
    function texture(seed) {
      var value = seed;
      var canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      var context = canvas.getContext('2d');
      for (var y = 0; y < 16; y += 1) {
        for (var x = 0; x < 16; x += 1) {
          value = (value * 1103515245 + 12345) & 0x7fffffff;
          context.fillStyle = shades[Math.floor((value / 0x7fffffff) * shades.length)];
          context.fillRect(x, y, 1, 1);
        }
      }
      return canvas.toDataURL();
    }
    var board = document.createElement('div');
    board.className = 'puzzle__board';
    var spot = function (node, place) {
      node.style.translate = (place % SIDE) * CELL + 'px ' + Math.floor(place / SIDE) * CELL + 'px';
    };
    var cells = [];
    for (var place = 0; place < SIDE * SIDE; place += 1) {
      var slot = document.createElement('span');
      slot.className = 'puzzle__slot';
      spot(slot, place);
      board.appendChild(slot);
    }
    for (var index = 0; index < SIDE * SIDE - 1; index += 1) {
      var cube = document.createElement('span');
      cube.className = 'puzzle__cube';
      var top = texture(index * 31 + 7);
      var side = texture(index * 13 + 5);
      [['top', top], ['south', side], ['east', side]].forEach(function (pair) {
        var face = document.createElement('span');
        face.className = 'puzzle__face puzzle__face--' + pair[0];
        face.style.backgroundImage = 'url(' + pair[1] + ')';
        cube.appendChild(face);
      });
      spot(cube, index);
      cells[index] = cube;
      board.appendChild(cube);
    }
    cells[SIDE * SIDE - 1] = null;
    row.appendChild(board);
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var empty = SIDE * SIDE - 1;
    var previous = -1;
    setInterval(function () {
      var x = empty % SIDE;
      var y = Math.floor(empty / SIDE);
      var near = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
        .filter(function (p) { return p[0] >= 0 && p[0] < SIDE && p[1] >= 0 && p[1] < SIDE; })
        .map(function (p) { return p[1] * SIDE + p[0]; })
        .filter(function (p) { return p !== previous; });
      var from = near[Math.floor(Math.random() * near.length)];
      var moving = cells[from];
      cells[empty] = moving;
      cells[from] = null;
      spot(moving, empty);
      previous = empty;
      empty = from;
    }, 520);
  })();

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
