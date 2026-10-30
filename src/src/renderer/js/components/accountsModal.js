import { api } from '../services/api.js';
import { morph } from '../core/effects.js';
import { h, icon } from '../core/dom.js';
import { store } from '../state/appStore.js';
import { refreshAccounts } from '../state/actions.js';
import { toast } from './toast.js';
import { openModal, confirmDialog } from './modal.js';
import { errorMessage } from '../core/format.js';
import { accountHead, forgetAccountHead } from '../core/skinHead.js';

const ACCOUNT_TYPE_LABELS = { microsoft: 'Microsoft', ely: 'Ely.by', offline: 'Офлайн' };
const ELY_REGISTER_URL = 'https://account.ely.by/register';
const ELY_RESTORE_URL = 'https://account.ely.by/forgot-password';

/** Modal for choosing, adding and removing accounts: Microsoft, Ely.by and offline. */
export function openAccountsModal() {
  const list = h('div', { class: 'account-list' });
  let method = 'microsoft';

  // --- Microsoft ---
  const microsoftButton = h(
    'button',
    { class: 'btn btn--primary btn--block', type: 'button', onclick: () => addMicrosoft() },
    icon('user'),
    'Войти через Microsoft',
  );
  const microsoftPanel = h(
    'div',
    { class: 'auth-panel' },
    h('p', { class: 'field__hint' }, 'Лицензионный аккаунт Minecraft. Откроется официальная страница входа Microsoft (login.live.com): пароль вводится только там.'),
    microsoftButton,
  );

  // --- Ely.by ---
  const elyLogin = h('input', { class: 'input', type: 'text', placeholder: 'Ник или e-mail', autocomplete: 'username', spellcheck: 'false' });
  const elyPassword = h('input', { class: 'input', type: 'password', placeholder: 'Пароль', autocomplete: 'current-password' });
  const elyCode = h('input', { class: 'input', type: 'text', inputmode: 'numeric', maxlength: '8', placeholder: 'Код из приложения', autocomplete: 'one-time-code' });
  const elyCodeField = h('label', { class: 'field', hidden: true }, h('span', { class: 'field__label' }, 'Код двухфакторной аутентификации'), elyCode);
  const elyButton = h('button', { class: 'btn btn--primary btn--block', type: 'submit' }, 'Войти через Ely.by');
  // First choice: the Ely.by site in the browser (sign in or register there). The password form
  // below is the fallback, shown on request, when the site way fails or the build has no Ely.by app.
  const elySiteButton = h('button', { class: 'btn btn--primary btn--block', type: 'button', onclick: () => addElyBrowser() }, 'Войти на сайте Ely.by');
  const elyPasswordToggle = h('button', { class: 'link-button', type: 'button', onclick: () => showElyPasswordForm() }, 'Войти по логину и паролю в лаунчере');
  const elySite = h(
    'div',
    { class: 'auth-site', hidden: true },
    h('p', { class: 'field__hint' }, 'Откроется сайт Ely.by в браузере: войдите там или зарегистрируйтесь, лаунчер получит аккаунт сам. Пароль вводится только на сайте.'),
    elySiteButton,
    h('div', { class: 'auth-links' }, elyPasswordToggle),
  );
  const elyPasswordFields = h(
    'div',
    { class: 'auth-password' },
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Логин'), elyLogin),
    h('label', { class: 'field' }, h('span', { class: 'field__label' }, 'Пароль'), elyPassword),
    elyCodeField,
    elyButton,
    h(
      'div',
      { class: 'auth-links' },
      h('button', { class: 'link-button', type: 'button', onclick: () => api.app.openExternal(ELY_REGISTER_URL) }, 'Регистрация на Ely.by'),
      h('button', { class: 'link-button', type: 'button', onclick: () => api.app.openExternal(ELY_RESTORE_URL) }, 'Забыли пароль?'),
    ),
    h('p', { class: 'field__hint' }, 'Пароль отправляется только на сервер Ely.by и не сохраняется: лаунчер хранит зашифрованный токен сессии.'),
  );
  const elyForm = h(
    'form',
    {
      class: 'auth-panel',
      onsubmit: (event) => {
        event.preventDefault();
        addEly();
      },
    },
    h('div', { class: 'ely-banner' }, h('span', { class: 'ely-banner__logo' }, 'ely.by'), h('span', null, 'Свой скин и плащ, игра на серверах Ely.by, вход без лицензии.')),
    elySite,
    elyPasswordFields,
  );
  function showElyPasswordForm() {
    elyPasswordFields.hidden = false;
    elyPasswordToggle.hidden = true;
    elyLogin.focus();
  }
  api.accounts
    .elyBrowserAvailable()
    .then((available) => {
      elySite.hidden = !available;
      elyPasswordFields.hidden = available;
    })
    .catch(() => {});

  // --- Offline ---
  const nameInput = h('input', {
    class: 'input',
    type: 'text',
    maxlength: '16',
    placeholder: 'Ник без пробелов, 3–16 символов',
    autocomplete: 'off',
    spellcheck: 'false',
    onkeydown: (event) => {
      if (event.key === 'Enter') {
        addOffline();
      }
    },
  });
  const offlinePanel = h(
    'div',
    { class: 'auth-panel' },
    h('p', { class: 'field__hint' }, 'Играть без входа. Работает в одиночной игре и на серверах, которые не проверяют лицензию. Скин рисуется во вкладке «Скины».'),
    nameInput,
    h('button', { class: 'btn btn--secondary btn--block', type: 'button', onclick: () => addOffline() }, 'Добавить офлайн-профиль'),
  );

  const panels = { microsoft: microsoftPanel, ely: elyForm, offline: offlinePanel };
  const tabButtons = [
    ['microsoft', 'Microsoft'],
    ['ely', 'Ely.by'],
    ['offline', 'Офлайн'],
  ].map(([value, label]) =>
    h('button', { class: 'tabs__button', type: 'button', role: 'tab', 'aria-selected': String(value === method), onclick: () => setMethod(value) }, label),
  );
  const panelHost = h('div', { class: 'auth-host' });

  function setMethod(value) {
    // The dialog grows or shrinks to the new form while the old one fades into it (the first time it just appears).
    if (method !== value && panelHost.isConnected) {
      morph(() => showMethod(value), { panel: panelHost.closest('.modal') });
      return;
    }
    showMethod(value);
  }

  function showMethod(value) {
    method = value;
    tabButtons.forEach((button, index) => button.setAttribute('aria-selected', String(['microsoft', 'ely', 'offline'][index] === value)));
    panelHost.replaceChildren(panels[value]);
    panels[value].classList.remove('auth-panel--in');
    void panels[value].offsetWidth;
    panels[value].classList.add('auth-panel--in');
    panels[value].querySelector('input')?.focus();
  }

  function renderList() {
    const { accounts, selectedAccountId } = store.get();
    if (accounts.length === 0) {
      list.replaceChildren(h('p', { class: 'text-muted' }, 'Аккаунтов пока нет. Войдите через Microsoft или Ely.by, или создайте офлайн-профиль.'));
      return;
    }
    list.replaceChildren(
      ...accounts.map((account, index) => {
        const selected = account.id === selectedAccountId;
        const avatar = h('span', { class: `account-row__avatar account-row__avatar--${account.type}` }, account.username.charAt(0).toUpperCase());
        accountHead(account).then((head) => head && avatar.replaceChildren(h('img', { src: head, alt: '' })));
        return h(
          'div',
          {
            class: `list-row account-row rise${selected ? ' account-row--selected' : ''}`,
            style: { '--delay': `${index * 40}ms` },
            role: 'button',
            tabindex: '0',
            onclick: () => selectAccount(account.id),
            onkeydown: (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                selectAccount(account.id);
              }
            },
          },
          avatar,
          h(
            'span',
            { class: 'account-row__meta' },
            h('span', { class: 'account-row__name' }, account.username),
            h('span', { class: 'account-row__uuid text-muted', title: account.uuid }, account.uuid),
          ),
          h('span', { class: `badge badge--${account.type}` }, ACCOUNT_TYPE_LABELS[account.type] ?? account.type),
          h(
            'button',
            {
              class: 'icon-button',
              type: 'button',
              'aria-label': `Удалить ${account.username}`,
              title: 'Удалить аккаунт',
              onclick: (event) => {
                event.stopPropagation();
                removeAccount(account);
              },
            },
            icon('close'),
          ),
          h('span', { class: 'account-row__check', 'aria-hidden': 'true' }),
        );
      }),
    );
  }

  async function selectAccount(accountId) {
    try {
      const result = await api.accounts.select(accountId);
      store.set({ accounts: result.accounts, selectedAccountId: result.selectedId });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function removeAccount(account) {
    const confirmed = await confirmDialog({
      title: 'Удалить аккаунт?',
      message: `Аккаунт ${account.username} будет удалён из лаунчера. Игровые сохранения не затрагиваются.`,
      confirmLabel: 'Удалить',
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    try {
      const result = await api.accounts.remove(account.id);
      forgetAccountHead(account.id);
      store.set({ accounts: result.accounts, selectedAccountId: result.selectedId });
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  async function addMicrosoft() {
    microsoftButton.disabled = true;
    try {
      await api.accounts.addMicrosoft();
      await refreshAccounts();
      toast('Аккаунт Microsoft добавлен', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      microsoftButton.disabled = false;
    }
  }

  async function addEly() {
    if (!elyLogin.value.trim() || !elyPassword.value) {
      toast('Введите логин и пароль Ely.by.', 'error');
      return;
    }
    elyButton.disabled = true;
    elyButton.textContent = 'Вход…';
    try {
      const result = await api.accounts.addEly({ username: elyLogin.value.trim(), password: elyPassword.value, totp: elyCode.value });
      if (result.twoFactorRequired) {
        elyCodeField.hidden = false;
        elyCode.value = '';
        elyCode.focus();
        toast('Введите код двухфакторной аутентификации из приложения.', 'info');
        return;
      }
      elyPassword.value = '';
      elyCode.value = '';
      elyCodeField.hidden = true;
      await refreshAccounts();
      toast(`Вы вошли как ${result.account.username}`, 'success', 4200, { title: 'Ely.by' });
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      elyButton.disabled = false;
      elyButton.textContent = 'Войти через Ely.by';
    }
  }

  async function addElyBrowser() {
    elySiteButton.disabled = true;
    elySiteButton.textContent = 'Ждём вход на сайте…';
    try {
      const result = await api.accounts.addElyBrowser();
      await refreshAccounts();
      toast(`Вы вошли как ${result.account.username}`, 'success', 4200, { title: 'Ely.by' });
    } catch (error) {
      // The site way did not work: the password form is the next try.
      toast(`${errorMessage(error)} Можно войти по логину и паролю.`, 'error', 6000);
      showElyPasswordForm();
    } finally {
      elySiteButton.disabled = false;
      elySiteButton.textContent = 'Войти на сайте Ely.by';
    }
  }

  async function addOffline() {
    try {
      await api.accounts.addOffline(nameInput.value);
      nameInput.value = '';
      await refreshAccounts();
      toast('Офлайн-профиль добавлен', 'success');
    } catch (error) {
      toast(errorMessage(error), 'error');
    }
  }

  const content = h(
    'div',
    { class: 'modal__section' },
    list,
    h('div', { class: 'divider' }),
    h('span', { class: 'section-title', style: { marginBottom: '0' } }, 'Добавить аккаунт'),
    h('div', { class: 'tabs', role: 'tablist' }, tabButtons),
    panelHost,
  );

  renderList();
  setMethod(method);
  const unsubscribe = store.subscribe(['accounts', 'selectedAccountId'], renderList);
  openModal({ title: 'Аккаунты', content, wide: false, onClose: unsubscribe });
}
