import { api } from '../services/api.js';
import { h, icon } from '../core/dom.js';
import { errorMessage } from '../core/format.js';
import { store } from '../state/appStore.js';
import { refreshJavaRuntimes, saveSettings } from '../state/actions.js';
import { toast } from '../components/toast.js';
import { confirmDialog } from '../components/modal.js';
import { createProgress, createSegmented } from '../components/controls.js';

/** Which Minecraft versions need which Java, as a hint next to each version. */
const JAVA_NOTES = { 8: 'Minecraft 1.0–1.16', 11: 'старые моды и серверы', 13: '', 15: '', 16: 'Minecraft 1.17', 17: 'Minecraft 1.18–1.20.4', 21: 'Minecraft 1.20.5–1.21', 25: 'Minecraft 26.x' };

/**
 * Java page, as in Prism Launcher: the mode, every Java found on the PC, and installing any
 * version from Mojang, Adoptium, Azul, Amazon, Microsoft, BellSoft or Oracle.
 */
export function createJavaPage({ embedded = false } = {}) {
  const state = { vendors: [], vendor: null, major: 21 };

  const modeControl = createSegmented({
    options: [
      { value: 'auto', label: 'Автоматически' },
      { value: 'custom', label: 'Вручную' },
    ],
    value: store.get().settings?.javaMode ?? 'auto',
    onChange: (mode) => changeMode(mode),
  });
  const autoVendorSelect = h('select', { class: 'select select--compact', onchange: (event) => saveSettings({ javaVendor: event.target.value }).catch(() => {}) });
  const customPathInput = h('input', { class: 'input input--readonly', readonly: true, placeholder: 'Путь к java.exe не выбран' });
  const pathRow = h(
    'div',
    { class: 'path-row', style: { display: 'none' } },
    customPathInput,
    h('button', { class: 'btn btn--secondary btn--compact', type: 'button', onclick: () => pickJavaPath() }, icon('folder'), 'Выбрать'),
  );
  const runtimesContainer = h('div', { class: 'runtime-grid' });
  const vendorGrid = h('div', { class: 'vendor-grid' });
  const versionChips = h('div', { class: 'toolbar__chips' });
  const installButton = h('button', { class: 'btn btn--primary', type: 'button', onclick: () => install() }, icon('download'), 'Установить');
  const installProgress = createProgress();
  const installStatus = h('span', { class: 'text-muted', style: { fontSize: '13px' } });
  const progressRow = h('div', { class: 'java-install__progress', hidden: true }, installProgress.element, installStatus);
  const rescanButton = h('button', { class: 'btn btn--ghost btn--compact', type: 'button', onclick: () => rescan() }, icon('search'), 'Найти заново');

  const element = h(
    'section',
    // Inside Settings it is a section: no page title, the rescan button stays.
    { class: embedded ? 'java-section' : 'page', 'aria-label': 'Java' },
    h(
      'header',
      { class: embedded ? 'java-section__head' : 'page-header' },
      embedded ? h('p', { class: 'settings-card__desc' }, 'Каждой версии Minecraft нужна своя Java. Лаунчер подберёт её сам или поставит нужную от любого поставщика.') : h('div', null, h('h1', { class: 'page-title' }, 'Java'), h('p', { class: 'page-subtitle' }, 'Каждой версии Minecraft нужна своя Java. Лаунчер подберёт её сам или поставит нужную от любого поставщика.')),
      rescanButton,
    ),
    h(
      'div',
      { class: 'settings-stack' },
      h(
        'div',
        { class: 'surface settings-card settings-card--static' },
        h('div', { class: 'settings-row' }, h('div', { class: 'settings-row__text' }, h('span', { class: 'settings-card__title' }, 'Режим выбора Java'), h('span', { class: 'settings-card__desc' }, 'Автоматически: лаунчер берёт подходящую установленную Java или скачивает её.')), modeControl.element),
        h('div', { class: 'settings-row' }, h('div', { class: 'settings-row__text' }, h('span', { class: 'settings-row__title' }, 'Поставщик для автоустановки'), h('span', { class: 'settings-card__desc' }, 'Чью Java скачивать, когда нужной версии нет.')), autoVendorSelect),
        pathRow,
      ),
    ),
    h('h2', { class: 'section-title page-section' }, 'Установить Java'),
    h(
      'div',
      { class: 'surface settings-card settings-card--static java-install' },
      vendorGrid,
      h('div', { class: 'settings-row' }, h('div', { class: 'settings-row__text' }, h('span', { class: 'settings-row__title' }, 'Версия'), h('span', { class: 'settings-card__desc', id: 'java-version-note' })), versionChips),
      h('div', { class: 'java-install__actions' }, progressRow, installButton),
    ),
    h('h2', { class: 'section-title page-section' }, 'Установленные на компьютере'),
    runtimesContainer,
  );

  function changeMode(mode) {
    saveSettings({ javaMode: mode }).catch((error) => toast(errorMessage(error), 'error'));
    if (mode === 'custom' && !store.get().settings.javaPath) {
      toast('Выберите java.exe или нажмите «Использовать» у одной из найденных', 'info');
    }
  }

  async function pickJavaPath() {
    try {
      const path = await api.app.pickJavaExecutable();
      if (path) {
        await useRuntime(path);
      }
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function useRuntime(path) {
    try {
      await saveSettings({ javaMode: 'custom', javaPath: path });
      modeControl.setValue('custom');
      toast('Java выбрана вручную', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function removeRuntime(runtime) {
    const confirmed = await confirmDialog({ title: `Удалить Java ${runtime.majorVersion}?`, message: `${runtime.vendor ?? 'Java'} ${runtime.version} будет удалена из папки лаунчера.`, confirmLabel: 'Удалить', danger: true });
    if (!confirmed) return;
    try {
      await api.java.remove(runtime.path);
      if (store.get().settings?.javaPath?.toLowerCase() === runtime.path.toLowerCase()) {
        await saveSettings({ javaMode: 'auto', javaPath: '' });
      }
      await refreshJavaRuntimes();
      toast('Java удалена', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function rescan() {
    rescanButton.disabled = true;
    try {
      await refreshJavaRuntimes();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      rescanButton.disabled = false;
    }
  }

  let runtimesRendered = false;

  function renderRuntimes() {
    const { settings, javaRuntimes } = store.get();
    const isCustom = settings?.javaMode === 'custom';
    modeControl.setValue(settings?.javaMode ?? 'auto');
    pathRow.style.display = isCustom ? '' : 'none';
    customPathInput.value = settings?.javaPath ?? '';
    if (state.vendors.length > 0) {
      autoVendorSelect.value = settings?.javaVendor ?? 'temurin';
    }

    if (javaRuntimes === null) {
      runtimesContainer.replaceChildren(...[0, 1].map(() => h('div', { class: 'skeleton', style: { height: '150px' } })));
      return;
    }
    if (javaRuntimes.length === 0) {
      runtimesContainer.replaceChildren(h('div', { class: 'empty-state surface', style: { gridColumn: '1 / -1' } }, icon('stack'), h('p', null, 'Java на этом компьютере не найдена. Установите её выше.')));
      return;
    }
    const animate = !runtimesRendered;
    runtimesRendered = true;
    runtimesContainer.replaceChildren(
      ...javaRuntimes.map((runtime, index) => {
        const active = isCustom && settings.javaPath.toLowerCase() === runtime.path.toLowerCase();
        return h(
          'div',
          { class: `surface runtime-card${active ? ' runtime-card--active' : ''}${animate ? '' : ' runtime-card--static'}`, style: { '--delay': `${index * 50}ms` } },
          h('div', { class: 'runtime-card__head' }, h('span', { class: 'runtime-card__version' }, `Java ${runtime.majorVersion}`), active ? h('span', { class: 'badge' }, 'Выбрана') : h('span', { class: 'badge badge--muted' }, runtime.vendor ?? 'Java')),
          h('span', { class: 'text-soft', style: { fontSize: '13px' } }, `${runtime.vendor ?? ''} ${runtime.version}${runtime.is64Bit ? '' : ' · 32-бит'}`),
          runtime.is64Bit ? null : h('span', { class: 'text-muted', style: { fontSize: '12px' } }, '32-битная Java: Minecraft на ней не запустится.'),
          h('span', { class: 'runtime-card__path mono' }, runtime.path),
          h(
            'div',
            { class: 'runtime-card__actions' },
            h('button', { class: `btn ${active ? 'btn--ghost' : 'btn--secondary'} btn--compact`, type: 'button', disabled: active || !runtime.is64Bit, onclick: () => useRuntime(runtime.path) }, active ? 'Используется' : 'Использовать'),
            runtime.managed ? h('button', { class: 'icon-button', type: 'button', title: 'Удалить', onclick: () => removeRuntime(runtime) }, icon('close')) : null,
          ),
        );
      }),
    );
  }

  function renderVendors() {
    vendorGrid.replaceChildren(
      ...state.vendors.map((vendor) =>
        h(
          'button',
          { class: `vendor-option vendor-option--${vendor.id}`, type: 'button', 'aria-pressed': String(vendor.id === state.vendor), onclick: () => selectVendor(vendor.id) },
          h('span', { class: 'vendor-option__name' }, vendor.label),
          h('span', { class: 'vendor-option__desc' }, vendor.description),
          h('span', { class: 'vendor-option__versions' }, vendor.majors.join(' · ')),
        ),
      ),
    );
    const vendor = state.vendors.find((candidate) => candidate.id === state.vendor);
    if (!vendor.majors.includes(state.major)) {
      state.major = vendor.majors.includes(21) ? 21 : vendor.majors.at(-1);
    }
    versionChips.replaceChildren(
      ...vendor.majors.map((major) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(major === state.major), onclick: () => { state.major = major; renderVendors(); } }, `Java ${major}`)),
    );
    element.querySelector('#java-version-note').textContent = JAVA_NOTES[state.major] ? `Для: ${JAVA_NOTES[state.major]}` : '';
    autoVendorSelect.replaceChildren(...state.vendors.map((candidate) => h('option', { value: candidate.id }, candidate.label)));
    autoVendorSelect.value = store.get().settings?.javaVendor ?? 'temurin';
    installButton.replaceChildren(icon('download'), `Установить ${vendor.label} ${state.major}`);
  }

  function selectVendor(id) {
    state.vendor = id;
    renderVendors();
  }

  async function install() {
    const vendor = state.vendor;
    const major = state.major;
    installButton.disabled = true;
    try {
      const runtime = await api.java.install(major, vendor);
      toast(`Java ${runtime.version} установлена`, 'success');
      await refreshJavaRuntimes();
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      installButton.disabled = false;
    }
  }

  /** Download progress of the running Java install, in place (no re-render on every event). */
  function onTasks() {
    const running = Object.values(store.get().tasks).find((task) => task.kind === 'java' && task.state === 'running');
    progressRow.hidden = !running;
    if (running) {
      installProgress.set(running.percent, { indeterminate: running.percent === 0 });
      installStatus.textContent = `${running.label}: ${running.percent}%`;
    }
  }

  async function loadVendors() {
    try {
      state.vendors = await api.java.vendors();
      state.vendor ??= store.get().settings?.javaVendor ?? 'temurin';
      renderVendors();
    } catch (error) {
      vendorGrid.replaceChildren(h('p', { class: 'text-danger' }, errorMessage(error)));
    }
  }

  store.subscribe(['settings', 'javaRuntimes'], renderRuntimes);
  store.subscribe(['tasks'], onTasks);

  return {
    element,
    onShow: () => {
      renderRuntimes();
      if (state.vendors.length === 0) {
        loadVendors();
      }
      if (store.get().javaRuntimes === null) {
        refreshJavaRuntimes().catch((error) => toast(errorMessage(error), 'error'));
      }
    },
  };
}
