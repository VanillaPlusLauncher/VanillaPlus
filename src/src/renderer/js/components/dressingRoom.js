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
 * drawn. Your skin in the middle, Steve and Alex at the sides, then the skins of your library. New
 * ones come from a PNG file, a player's nick or a skin site (The Skindex, NameMC) (a skin downloaded there appears here
 * by itself). Four real 3D models of one size stand on a stage; turning the carousel moves them (the
 * middle one steps aside and shrinks, the side one comes forward, the fourth comes in from the edge).
 * "Надеть" keeps the one in the middle.
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
  const removeButton = h('button', { class: 'btn btn--ghost btn--compact wardrobe__remove', type: 'button', hidden: true }, icon('close'), h('span', null, 'Удалить'));
  // Until the skins are in, the stage says "Загрузка…" (no default Steve jumping in first).
  const stage = h('div', { class: 'wardrobe__stage wardrobe__stage--loading' }, h('span', { class: 'wardrobe__loading' }, 'Загрузка…'));
  let presets = [];
  let index = 0;
  let busy = false;
  let greeted = false;
  let defaults = null;

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
    nameLabel.replaceChildren(current?.libraryId ? h('span', { 'data-i18n': 'off' }, current.name) : h('span', null, current?.name ?? ''));
    wearButton.disabled = !current || current.current;
    removeButton.hidden = !current?.libraryId;
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

  /** Reads the skins; `focus` is the library id to put in the middle (else your skin). */
  async function load(focus = null) {
    if (!defaults) {
      const skins = getMcManifest()?.textures.skins ?? {};
      const preset = async (key, name, model) => (skins[key] ? { name, model, pngBase64: await urlToBase64(mcUrl(skins[key])).catch(() => null) } : null);
      const [steve, alex, current] = await Promise.all([preset('steve', 'Стив', 'classic'), preset('alex', 'Алекс', 'slim'), currentSkin(account)]);
      const mine = current ? { name: 'Ваш скин', model: current.model, pngBase64: current.pngBase64, capeBase64: current.capeBase64, current: true } : steve ? { ...steve, name: 'Ваш скин (Стив)', current: true } : null;
      defaults = { steve, alex, mine };
    }
    const library = await api.skins.library.list().catch(() => []);
    const { steve, alex, mine } = defaults;
    presets = [steve, mine, alex, ...library.map((item) => ({ name: item.name, model: item.model, pngBase64: item.pngBase64, libraryId: item.id }))].filter((item) => item?.pngBase64);
    const focused = focus ? presets.findIndex((item) => item.libraryId === focus) : -1;
    index = focused >= 0 ? focused : Math.max(0, presets.indexOf(mine));
    layout();
    if (mine?.capeBase64 && presets[index] === mine) {
      const middle = models.find((model) => model.element.dataset.pos === 'center');
      middle?.viewer?.setCape(`data:image/png;base64,${mine.capeBase64}`);
    }
  }

  const added = (item) => {
    if (item.duplicate) {
      toast(`«${item.name}» уже есть в гардеробе`, 'info');
    } else {
      sfx('skinSaved');
      toast(`Скин «${item.name}» в гардеробе`, 'success');
    }
    return load(item.id);
  };

  // --- Getting ready skins ----------------------------------------------------------------

  async function fromFile() {
    try {
      const item = await api.skins.library.importFile();
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
    if (!name) return;
    nickButton.disabled = true;
    try {
      const skin = await api.skins.byName(name, account.type === 'ely' ? 'ely' : 'mojang');
      const item = await api.skins.library.save(name, skin.pngBase64, skin.model);
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
    if (!chosen?.libraryId) return;
    const yes = await confirmDialog({ title: 'Убрать скин из гардероба?', message: `«${chosen.name}» пропадёт из гардероба. Если он надет, он останется надетым.`, confirmLabel: 'Убрать', danger: true });
    if (!yes) return;
    try {
      await api.skins.library.remove(chosen.libraryId);
      // The next skin of the library comes to the middle, or your own one when there is none.
      const next = presets.slice(index + 1).find((item) => item.libraryId) ?? presets.slice(0, index).reverse().find((item) => item.libraryId);
      await load(next?.libraryId ?? null);
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  });

  wearButton.addEventListener('click', async () => {
    const chosen = presets[index];
    if (!chosen) return;
    wearButton.disabled = true;
    try {
      // Offline: the skin in the game. Microsoft / Ely.by: the Amethyx skin (the profile stays).
      await api.skins.save(account.uuid, chosen.pngBase64, chosen.model);
      forgetAccountHead(account.id);
      store.set({ accounts: [...store.get().accounts] });
      sfx('skinSaved');
      toast(account.type === 'offline' ? `Скин «${chosen.name}» надет` : `Скин «${chosen.name}» надет как скин Amethyx`, 'success');
      onApplied?.(chosen);
      modal.close();
    } catch (error) {
      toast(errorMessage(error), 'error');
      wearButton.disabled = false;
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
  const openSite = (site) => api.skins.openSite(site).catch((error) => toast(errorMessage(error), 'error'));
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
  const modal = openModal({
    title: 'Гардероб',
    wide: true,
    content: h(
      'div',
      { class: 'wardrobe' },
      h('div', { class: 'wardrobe__frame' }, arrow(-1), stage, arrow(1)),
      h('div', { class: 'wardrobe__caption' }, nameLabel, removeButton),
      tools,
      nickRow,
      h('p', { class: 'wardrobe__hint text-soft' }, 'На сайте скинов нажмите кнопку скачивания у понравившегося скина — он сам появится здесь.'),
    ),
    footer: [h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => modal.close() }, 'Отмена'), wearButton],
    onClose: () => {
      document.removeEventListener('keydown', onKey);
      offSkinImported();
      models.forEach((model) => model.viewer?.dispose());
    },
  });
  load().catch((error) => nameLabel.replaceChildren(h('span', { class: 'text-danger' }, errorMessage(error))));
  return modal;
}
