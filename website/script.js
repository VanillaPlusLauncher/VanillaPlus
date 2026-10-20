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
    Array.prototype.forEach.call(document.querySelectorAll('.lightbox__close'), function (button) {
      button.setAttribute('aria-label', english ? 'Close' : 'Закрыть');
    });
    document.getElementById('video-open').setAttribute('aria-label', english ? 'Watch the video with sound' : 'Смотреть видео со звуком');
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

  // The promo: silent in the hero window; a click opens it large, with sound
  // (a little quieter than full volume). Closing pauses it.
  var player = document.getElementById('player');
  var playerVideo = player.querySelector('video');
  var FULL_VIDEO = 'assets/video/amethyx-promo.mp4';
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
