import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { getMcManifest, mcUrl } from '../core/mc.js';
import { forgetAccountHead } from '../core/skinHead.js';
import { sfx } from '../core/sound.js';
import { store } from '../state/appStore.js';
import { createSkinViewer3d } from '../skins/skinViewer3d.js';
import { GESTURE_EFFECTS, SHOWCASE } from '../skins/gestures.js';
import { createParticles } from '../skins/particles.js';
import { confirmDialog, openModal } from './modal.js';
import { toast } from './toast.js';

/**
 * The skin the account shows now: the launcher's own (offline skin, or the Amethyx skin of a
 * Microsoft / Ely.by account), else the profile's. { pngBase64, model, capeBase64 } or null.
 */
export async function currentSkin(account) {
  if (!account) return null;
  const stored = await api.skins.get(account.uuid).catch(() => null);
  const profile = account.type !== 'offline' ? await api.skins.accountSkin(account.id).catch(() => null) : null;
  const skin = stored?.pngBase64 ? stored : profile;
  return skin?.pngBase64 ? { pngBase64: skin.pngBase64, model: skin.model ?? 'classic', capeBase64: stored?.capeBase64 ?? profile?.capeBase64 ?? null } : null;
}

async function urlToBase64(url) {
  const blob = await (await fetch(url)).blob();
  const data = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  return String(data).split(',')[1];
}

/** Where a model stands relative to the middle: -1 left, 0 middle, 1 right, else hidden at a side. */
const POSITIONS = { '-1': 'left', 0: 'center', 1: 'right' };

/**
 * "Гардероб", like the Bedrock dressing room, and the only place for skins: skins are chosen, never
 * drawn. Five places: 1 — your main skin (the one you wear, never written over), 2–5 — slots. A new
 * skin (a PNG file, a player's nick, The Skindex or NameMC — a skin downloaded there arrives by
 * itself) is written into the slot in the middle. Four real 3D models of one size stand on a stage;
 * turning the carousel moves them (the middle one steps aside and shrinks, the side one comes
 * forward, the fourth comes in from the edge). "Надеть" makes the skin in the middle the main one.
 */
export function openDressingRoom({ onApplied } = {}) {
  const { accounts, selectedAccountId } = store.get();
  const account = accounts.find((candidate) => candidate.id === selectedAccountId);
  if (!account) {
    toast('Добавьте аккаунт, чтобы выбрать скин.', 'info');
    return null;
  }
  const nameLabel = h('div', { class: 'wardrobe__name' }, '…');
  const wearButton = h('button', { class: 'btn btn--primary btn--compact', type: 'button', disabled: true }, 'Надеть');
  const removeButton = h('button', { class: 'btn btn--ghost btn--compact wardrobe__remove', type: 'button', hidden: true }, icon('close'), h('span', null, 'Очистить слот'));
  // Until the skins are in, the stage says "Загрузка…" (no default Steve jumping in first).
  const stage = h('div', { class: 'wardrobe__stage wardrobe__stage--loading' }, h('span', { class: 'wardrobe__loading' }, 'Загрузка…'));
  let presets = [];
  let index = 0;
  let busy = false;
  let greeted = false;
  let defaults = null;
  // Ely.by accounts only: the skin in the middle is taken to the Ely.by site (see below).
  let elyButton = null;

  const effects = createParticles(stage);
  const models = [0, 1, 2, 3].map(() => {
    const viewer = createSkinViewer3d({ width: 240, height: 340, light: true });
    viewer?.setAutoRotate(false);
    const element = h('button', { class: 'wardrobe__model', type: 'button', 'data-pos': 'off-right' }, viewer ? viewer.canvas : null);
    // offset: the model's place, -1 left, 0 middle, 1 right, ±2 hidden behind a side.
    const model = { element, viewer, offset: 2 };
    element.addEventListener('click', () => {
      if (model.offset === -1 || model.offset === 1) move(model.offset);
    });
    stage.append(element);
    return model;
  });

  const wrap = (value) => ((value % presets.length) + presets.length) % presets.length;

  /** Puts the skin that belongs at the model's place (round the list) on it. */
  function dress(model) {
    const preset = presets[wrap(index + model.offset)];
    if (preset) model.viewer?.setSkin(`data:image/png;base64,${preset.pngBase64}`, preset.model);
    // An empty slot stands as a faint Steve.
    model.element.classList.toggle('wardrobe__model--empty', Boolean(preset?.empty));
  }

  /** The slot (1…4) a new skin is written into: the one in the middle; null on the main skin. */
  function targetSlot() {
    const slot = presets[index]?.slot;
    return slot >= 1 ? slot : null;
  }

  function place(model) {
    // With one skin only the middle stands; with two, no model on the right.
    const hidden = (presets.length < 2 && model.offset !== 0) || (presets.length < 3 && model.offset === 1);
    model.element.dataset.pos = hidden ? 'off-right' : POSITIONS[model.offset] ?? (model.offset < 0 ? 'off-left' : 'off-right');
    // Models hidden behind the sides are not drawn: four live models stay smooth.
    model.viewer?.setPaused(model.element.dataset.pos.startsWith('off'));
  }

  function update() {
    models.forEach(place);
    const middle = models.find((model) => model.element.dataset.pos === 'center');
    for (const model of models) model.viewer?.setNameTag(model === middle ? account.username : null);
    const current = presets[index];
    nameLabel.replaceChildren(
      ...[
        h('span', { class: 'wardrobe__slot' }, `${(current?.slot ?? 0) + 1}/5`),
        current?.libraryId ? h('span', { 'data-i18n': 'off' }, current.name) : h('span', null, current?.name ?? ''),
        current?.current && h('span', { class: 'wardrobe__worn' }, 'надет'),
      ].filter(Boolean),
    );
    wearButton.disabled = !current || current.current || current.empty;
    wearButton.textContent = current?.current ? 'Надет' : 'Надеть';
    if (elyButton) elyButton.disabled = !current || current.empty;
    removeButton.hidden = !current?.libraryId;
    // New skins are written only into the slot in the middle, never over the main one.
    const target = targetSlot();
    for (const button of tools.querySelectorAll('button')) button.disabled = target === null && button !== elyButton;
    writeHint.textContent = target === null
      ? 'Это ваш основной скин, его не перезаписать. Чтобы записать новый скин, стрелками перейдите на слот 2–5.'
      : current.empty
        ? `Новый скин запишется в слот ${target + 1}.`
        : `Новый скин запишется в слот ${target + 1} вместо «${current.name}».`;
    // The skin in the middle shows itself: "hello" when the Wardrobe opens, then each skin its own move.
    if (middle) {
      const gesture = greeted ? SHOWCASE[index % SHOWCASE.length] : 'hello';
      greeted = true;
      middle.viewer?.playGesture(gesture);
      effects.emit(GESTURE_EFFECTS[gesture] ?? 'sparkles', { count: 7, y: 30 });
    }
  }

  /** `sound`: only for the keyboard — a button click already plays the click sound by itself. */
  function move(step, sound = false) {
    if (presets.length < 2 || busy) return;
    busy = true;
    if (sound) sfx('click');
    // The fourth model jumps, unseen, behind the side the carousel turns towards and gets its skin.
    const spare = models.find((model) => Math.abs(model.offset) === 2);
    spare.element.classList.add('wardrobe__model--instant');
    spare.offset = 2 * step;
    dress(spare);
    place(spare);
    void spare.element.offsetWidth;
    spare.element.classList.remove('wardrobe__model--instant');
    // Everyone moves one place; the spare comes in, the far side model goes behind.
    index = wrap(index + step);
    for (const model of models) model.offset -= step;
    update();
    setTimeout(() => {
      busy = false;
    }, 420);
  }

  /** Lays the carousel out again around `presets[index]`, without the turning animation. */
  function layout() {
    [-1, 0, 1, 2].forEach((offset, position) => {
      models[position].offset = offset;
      dress(models[position]);
    });
    models.forEach((model) => model.element.classList.add('wardrobe__model--instant'));
    update();
    requestAnimationFrame(() => {
      models.forEach((model) => model.element.classList.remove('wardrobe__model--instant'));
      stage.classList.remove('wardrobe__stage--loading');
    });
  }

  /**
   * Five places: 1 — the main skin (the one you wear; it cannot be removed or written over), 2–5 —
   * slots that skins are written into. `focusSlot` is the place to put in the middle (else the main).
   */
  async function load(focusSlot = null) {
    if (!defaults) {
      const skins = getMcManifest()?.textures.skins ?? {};
      const [steve, current] = await Promise.all([skins.steve ? urlToBase64(mcUrl(skins.steve)).catch(() => null) : null, currentSkin(account)]);
      defaults = { steve, main: current ?? (steve ? { pngBase64: steve, model: 'classic', capeBase64: null } : null) };
    }
    const slots = await api.skins.slots.list().catch(() => [null, null, null, null]);
    const { steve, main } = defaults;
    presets = [
      main && { slot: 0, main: true, current: true, name: 'Основной скин', model: main.model, pngBase64: main.pngBase64, capeBase64: main.capeBase64 },
      ...slots.map((item, position) =>
        item
          ? { slot: position + 1, name: item.name, model: item.model, pngBase64: item.pngBase64, libraryId: item.id, current: item.pngBase64 === main?.pngBase64 }
          : { slot: position + 1, empty: true, name: 'Пустой слот', model: 'classic', pngBase64: steve },
      ),
    ].filter((item) => item?.pngBase64);
    const focused = focusSlot === null ? -1 : presets.findIndex((item) => item.slot === focusSlot);
    index = Math.max(0, focused);
    layout();
    if (presets[index]?.main && presets[index].capeBase64) {
      const middle = models.find((model) => model.element.dataset.pos === 'center');
      middle?.viewer?.setCape(`data:image/png;base64,${presets[index].capeBase64}`);
    }
  }

  const added = (item) => {
    if (item.duplicate) {
      toast(`«${item.name}» уже есть в слоте ${item.slot + 1}`, 'info');
    } else {
      sfx('skinSaved');
      toast(`Скин «${item.name}» записан в слот ${item.slot + 1}`, 'success');
    }
    return load(item.slot ?? null);
  };

  // --- Getting ready skins ----------------------------------------------------------------

  async function fromFile() {
    const slot = targetSlot();
    if (slot === null) return;
    try {
      const item = await api.skins.library.importFile(slot);
      if (item) await added(item);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const nickInput = h('input', { class: 'input wardrobe__nick-input', type: 'text', maxlength: 16, placeholder: 'Ник игрока, например Notch', spellcheck: 'false' });
  const nickButton = h('button', { class: 'btn btn--secondary btn--compact', type: 'button' }, 'Найти');
  const nickRow = h('form', { class: 'wardrobe__nick', hidden: true }, nickInput, nickButton);
  nickRow.addEventListener('submit', async (event) => {
    event.preventDefault();
    const name = nickInput.value.trim();
    const slot = targetSlot();
    if (!name || slot === null) return;
    nickButton.disabled = true;
    try {
      const skin = await api.skins.byName(name, account.type === 'ely' ? 'ely' : 'mojang');
      const item = await api.skins.slots.save(slot, name, skin.pngBase64, skin.model);
      nickInput.value = '';
      nickRow.hidden = true;
      await added(item);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      nickButton.disabled = false;
    }
  });

  const offSkinImported = api.events.onSkinImported(({ item, error }) => {
    if (error) toast(error, 'error');
    else if (item) added(item).catch(() => {});
  });

  removeButton.addEventListener('click', async () => {
    const chosen = presets[index];
    if (!chosen?.libraryId || !(chosen.slot >= 1)) return;
    const yes = await confirmDialog({ title: `Очистить слот ${chosen.slot + 1}?`, message: `«${chosen.name}» пропадёт из гардероба. Основной скин это не затронет.`, confirmLabel: 'Очистить', danger: true });
    if (!yes) return;
    try {
      await api.skins.slots.clear(chosen.slot);
      await load(chosen.slot);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  });

  wearButton.addEventListener('click', async () => {
    const chosen = presets[index];
    if (!chosen) return;
    wearButton.disabled = true;
    wearButton.textContent = account.type === 'microsoft' ? 'Загружаем…' : 'Надеваем…';
    try {
      // Offline: the skin in the game. Microsoft: also the profile's real skin (every server shows
      // it). Ely.by: the Amethyx skin; the site's own skin is changed on ely.by ("На Ely.by").
      const result = await api.skins.wear(account.id, chosen.pngBase64, chosen.model);
      forgetAccountHead(account.id);
      store.set({ accounts: [...store.get().accounts] });
      sfx('skinSaved');
      if (account.type === 'microsoft' && result?.uploadError) {
        toast(`Скин надет в лаунчере, но в профиль Microsoft не загружен: ${result.uploadError}`, 'error', 7000);
      } else if (account.type === 'microsoft') {
        toast(`Скин «${chosen.name}» надет: его видят все игроки на любых серверах`, 'success');
      } else if (account.type === 'ely') {
        toast(`Скин «${chosen.name}» надет как скин Amethyx. Чтобы его видели все на серверах Ely.by — кнопка «На Ely.by» в гардеробе.`, 'success', 7000);
      } else {
        toast(`Скин «${chosen.name}» надет`, 'success');
      }
      onApplied?.(chosen);
      modal.close();
    } catch (error) {
      toast(errorMessage(error), 'error');
      wearButton.disabled = false;
      wearButton.textContent = 'Надеть';
    }
  });

  const resetButton = h('button', { class: 'btn btn--ghost wardrobe__reset', type: 'button' }, 'Сбросить скин');
  resetButton.addEventListener('click', async () => {
    const message =
      account.type === 'microsoft'
        ? 'В профиле Microsoft снова будет стандартный скин (Стив или Алекс) — во всех играх и на всех серверах.'
        : account.type === 'ely'
          ? 'Скин Amethyx уберётся, снова будет виден скин вашего профиля Ely.by.'
          : 'В игре снова будет стандартный скин.';
    const yes = await confirmDialog({ title: 'Сбросить скин?', message, confirmLabel: 'Сбросить', danger: true });
    if (!yes) return;
    resetButton.disabled = true;
    try {
      await api.skins.reset(account.id);
      forgetAccountHead(account.id);
      store.set({ accounts: [...store.get().accounts] });
      toast('Скин сброшен', 'success');
      onApplied?.(null);
      modal.close();
    } catch (error) {
      toast(errorMessage(error), 'error');
      resetButton.disabled = false;
    }
  });

  const onKey = (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.key === 'ArrowLeft') move(-1, true);
    if (event.key === 'ArrowRight') move(1, true);
  };
  document.addEventListener('keydown', onKey);

  const arrow = (step) =>
    h('button', { class: `icon-button wardrobe__arrow wardrobe__arrow--${step < 0 ? 'left' : 'right'}`, type: 'button', 'aria-label': step < 0 ? 'Предыдущий' : 'Следующий', onclick: () => move(step) }, h('span', { class: `wardrobe__chevron${step < 0 ? ' wardrobe__chevron--left' : ''}` }, icon('chevron')));
  // The site's download goes into the slot that is in the middle now.
  const openSite = (site) => {
    const slot = targetSlot();
    if (slot !== null) api.skins.openSite(site, slot).catch((error) => toast(errorMessage(error), 'error'));
  };
  const writeHint = h('p', { class: 'wardrobe__hint text-soft' });
  const tool = (iconName, label, onclick) => h('button', { class: 'btn btn--ghost btn--compact wardrobe__tool', type: 'button', onclick }, icon(iconName), h('span', null, label));
  const tools = h(
    'div',
    { class: 'wardrobe__tools' },
    tool('folder', 'Загрузить PNG', fromFile),
    tool('user', 'По нику', () => {
      nickRow.hidden = !nickRow.hidden;
      if (!nickRow.hidden) nickInput.focus();
    }),
    tool('download', 'The Skindex', () => openSite('skindex')),
    tool('download', 'NameMC', () => openSite('namemc')),
  );
  if (account.type === 'ely') {
    // Ely.by lets no launcher change the skin: the file is handed over for the site's upload page.
    elyButton = tool('image', 'На Ely.by', async () => {
      const chosen = presets[index];
      if (!chosen) return;
      try {
        await api.skins.toEly(chosen.pngBase64, chosen.name);
        toast('Файл скина открыт в папке, а в браузере — страница Ely.by. Перетащите файл на страницу и нажмите галочку, чтобы надеть.', 'info', 9000);
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    });
    tools.append(elyButton);
  }
  /** How skins get here, in three steps (the sites were not obvious). */
  const step = (number, text) => h('li', { class: 'wardrobe__step' }, h('span', { class: 'wardrobe__step-number' }, String(number)), h('span', null, text));
  const help = h(
    'ol',
    { class: 'wardrobe__steps' },
    step(1, 'Стрелками выберите слот 2–5 и нажмите The Skindex или NameMC'),
    step(2, 'Выберите скин и нажмите на нём «Download»'),
    step(3, 'Скин запишется в этот слот — нажмите «Надеть»'),
  );
  const modal = openModal({
    title: 'Гардероб',
    wide: true,
    content: h(
      'div',
      { class: 'wardrobe' },
      h('div', { class: 'wardrobe__frame' }, arrow(-1), stage, arrow(1)),
      h('div', { class: 'wardrobe__caption' }, nameLabel, removeButton),
      tools,
      writeHint,
      nickRow,
      help,
    ),
    footer: [resetButton, h('span', { class: 'wardrobe__footer-gap' }), h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), wearButton],
    onClose: () => {
      document.removeEventListener('keydown', onKey);
      offSkinImported();
      models.forEach((model) => model.viewer?.dispose());
    },
  });
  load().catch((error) => nameLabel.replaceChildren(h('span', { class: 'text-danger' }, errorMessage(error))));
  return modal;
}
