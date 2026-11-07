// Site screenshots (AMETHYX_MAIN_SCRIPT), run by make-shots.ps1 in a made-up profile: the player
// Amethyst_Alex with a skin, five instances (Fabric 26.3 with real mods), demo friends from
// demo-friends.js on 127.0.0.1:8797. The window renders off-screen at 1440 × 900.
// PNGs go to TT_OUT as <shot>-<lang>.png. SHOTS_LANGS=en,ru picks the languages, SHOTS_ONLY=home,mods
// limits the set.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const out = process.env.TT_OUT || __dirname;
const only = (process.env.SHOTS_ONLY || '').split(',').filter(Boolean);
const languages = (process.env.SHOTS_LANGS || 'en,ru').split(',');

module.exports = async ({ log, window }) => {
  window.setContentSize(1440, 900);
  const wc = window.webContents;
  wc.setBackgroundThrottling(false);
  if (wc.isOffscreen()) wc.setFrameRate(30);
  const js = (code) => wc.executeJavaScript(`(async () => { ${code} })()`).catch((e) => 'js error ' + e.message);
  const errors = [];
  wc.on('console-message', (...args) => { const e = args[0]; const level = e?.level ?? args[1]; const message = e?.message ?? args[2]; if (level === 'error' || level === 3) errors.push(String(message).slice(0, 200)); });
  const grab = async () => {
    if (!wc.isOffscreen()) return wc.capturePage();
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(wc.capturePage()), 4000);
      wc.once('paint', (_event, _dirty, image) => { clearTimeout(timer); resolve(image); });
      wc.invalidate();
    });
  };
  const shot = async (name) => {
    await wait(400);
    const image = await grab();
    const size = image.getSize();
    const png = size.width === 1440 ? image.toPNG() : image.resize({ width: 1440, height: 900, quality: 'best' }).toPNG();
    fs.writeFileSync(path.join(out, name + '.png'), png);
    log(`   shot ${name} (${size.width}x${size.height})`);
  };
  const until = async (code, ms = 20000) => {
    for (let waited = 0; waited < ms; waited += 400) {
      if ((await js(code)) === true) return true;
      await wait(400);
    }
    return false;
  };
  const clickText = (selector, re) => js(`const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.offsetParent && ${re}.test(x.textContent.trim())); if (!b) return 'none'; b.click(); return 'clicked ' + b.textContent.trim().slice(0, 40)`);
  const closeModals = async () => {
    for (let i = 0; i < 3; i += 1) {
      const r = await js(`const b = [...document.querySelectorAll('.modal-layer button')].find((x) => /^(Close|Закрыть)$/.test(x.getAttribute('aria-label') || '')); if (!b) return 'none'; b.click(); return 'closed'`);
      if (r === 'none') break;
      await wait(700);
    }
  };

  log('size: ' + JSON.stringify(window.getContentSize()) + ', offscreen: ' + wc.isOffscreen());
  await until(`return Boolean(document.querySelector('.nav-button'))`, 60000);

  // --- Set up once: the player, the skin, the Wardrobe slots, no tour -------------------------
  const skinsDir = path.join(app.getPath('userData'), 'mc-ui', 'skins');
  // A new profile takes Minecraft's default skins from the game files first (a download).
  for (let waited = 0; waited < 180000 && !fs.existsSync(path.join(skinsDir, 'zuri.png')); waited += 500) await wait(500);
  const skin = (name) => fs.readFileSync(path.join(skinsDir, `${name}.png`)).toString('base64');
  const setup = await js(`
    try { localStorage.setItem('amethyx.tour.done', '1'); } catch {}
    const api = window.amethyx;
    let list = await api.accounts.list();
    let accounts = list.accounts ?? list;
    let me = accounts.find((a) => a.username === 'Amethyst_Alex');
    if (!me) { await api.accounts.addOffline('Amethyst_Alex'); list = await api.accounts.list(); accounts = list.accounts ?? list; me = accounts.find((a) => a.username === 'Amethyst_Alex'); }
    for (const a of accounts) if (a.id !== me.id) await api.accounts.remove(a.id);
    await api.accounts.select(me.id);
    await api.skins.wear(me.id, ${JSON.stringify(skin('zuri'))}, 'classic');
    const slots = await api.skins.slots.list();
    const want = [['Alex', ${JSON.stringify(skin('alex'))}, 'slim'], ['Sunny', ${JSON.stringify(skin('sunny'))}, 'classic'], ['Noor', ${JSON.stringify(skin('noor'))}, 'slim'], ['Kai', ${JSON.stringify(skin('kai'))}, 'classic']];
    for (let i = 0; i < 4; i += 1) if (!slots[i]) await api.skins.slots.save(i + 1, want[i][0], want[i][1], want[i][2]);
    return { id: me.id, accounts: (await api.accounts.list()).accounts?.length };
  `);
  log('setup: ' + JSON.stringify(setup));
  // A fresh start with everything in place (home player, account chip, friends).
  wc.reload();
  await wait(3000);
  await until(`return Boolean(document.querySelector('.nav-button'))`, 60000);
  await wait(6000);
  await closeModals();

  const want = (name) => only.length === 0 || only.includes(name);
  for (const language of languages) {
    log(`== ${language}`);
    await js(`const { saveSettings } = await import('./js/state/actions.js'); await saveSettings({ ui: { language: ${JSON.stringify(language)} } }); return 1`);
    await wait(2500);
    const nav = (route) => js(`const { go } = await import('./js/core/nav.js'); go(${JSON.stringify(route)}); return 1`);

    if (want('home')) {
      await nav('home');
      await until(`return document.querySelectorAll('.news-tile__image').length > 0 && [...document.querySelectorAll('.news-tile__image')].every((i) => i.complete)`, 30000);
      await wait(3500);
      await shot(`home-${language}`);
    }

    if (want('wardrobe')) {
      await nav('home');
      await wait(800);
      await js(`const m = await import('./js/components/dressingRoom.js'); m.openDressingRoom(); return 1`);
      await until(`const s = document.querySelector('.wardrobe__stage'); return Boolean(s && !s.classList.contains('wardrobe__stage--loading'))`, 30000);
      await wait(3500);
      await shot(`wardrobe-${language}`);
      await closeModals();
      await wait(800);
    }

    if (want('library')) {
      await js(`const { browseFor } = await import('./js/core/nav.js'); browseFor('Create Skyline', 'mod'); return 1`);
      await until(`return document.querySelectorAll('.project-card img').length >= 4 && [...document.querySelectorAll('.project-card img')].slice(0, 6).every((i) => i.complete)`, 30000);
      await wait(2500);
      await shot(`library-${language}`);
    }

    if (want('friends')) {
      await nav('friends');
      await wait(2500);
      log('   friend: ' + await clickText('button, .friend-row, [role="button"], li', /^Kira_Craft/));
      await until(`return document.body.textContent.includes('trains are insane')`, 15000);
      await wait(2500);
      await shot(`friends-${language}`);
    }

    if (want('mods') || want('servers')) {
      await js(`const { openInstance } = await import('./js/core/nav.js'); openInstance('Fabric 26.3', 'mod'); return 1`);
      await wait(1500);
      await js(`const b = document.querySelector('.view-toggle[data-view="grid"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); return 1`);
      await until(`const imgs = [...document.querySelectorAll('.content-list img, .content-grid img, img')].filter((i) => i.offsetParent); return imgs.length > 10 && imgs.every((i) => i.complete)`, 30000);
      await wait(3000);
      if (want('mods')) await shot(`mods-${language}`);
      if (want('servers')) {
        await js(`document.querySelector('.tabs__button[data-tab="servers"]')?.click(); return 1`);
        await wait(1200);
        await js(`const b = document.querySelectorAll('.servers-tab__switch .segmented button')[2]; b?.click(); return Boolean(b)`);
        await until(`return Boolean(document.querySelector('.server-export__grid'))`, 15000);
        await wait(2500);
        await shot(`servers-${language}`);
      }
    }
  }
  log('console errors: ' + JSON.stringify([...new Set(errors)].slice(0, 15)));
};
