'use strict';
// Таблица подключений: поиск, отбор по признаку «бой», сортировка по любой колонке, правка записей.
// Отбор и сортировку выполняет сервер (GET /api/connections), страница только передаёт параметры.

const COLUMNS = [
  { key: 'title', label: 'Название' },
  { key: 'infobase', label: 'База (ИБ)' },
  { key: 'prod', label: 'Бой', type: 'bool' },
  { key: 'name', label: 'MCP-сервер' },
  { key: 'config', label: 'Конфигурация' },
  { key: 'url', label: 'Адрес подключения' },
  { key: 'cluster', label: 'Кластер 1С' },
  { key: 'dump', label: 'Выгрузка' },
  { key: 'allowExecute', label: 'Выполнение кода', type: 'bool' },
  { key: 'note', label: 'Примечание' },
];

const state = { q: '', prod: '', sort: 'title', order: 'asc', rows: [], editingId: null };

const head = document.getElementById('table-head');
const body = document.getElementById('table-body');
const emptyNote = document.getElementById('empty');
const counter = document.getElementById('counter');
const editor = document.getElementById('editor');
const editorForm = document.getElementById('editor-form');
const editorFields = document.getElementById('editor-fields');
const editorError = document.getElementById('editor-error');

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
  });
  if (response.status === 401) {
    location.href = '/login';
    throw new Error('Требуется вход');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Ошибка ${response.status}`);
  return data;
}

// ---------- Таблица ----------

function renderHead() {
  head.replaceChildren(
    ...COLUMNS.map((column) => {
      const active = state.sort === column.key;
      const button = element('button', {
        type: 'button',
        className: 'sort',
        textContent: column.label + (active ? (state.order === 'asc' ? ' ▲' : ' ▼') : ''),
      });
      button.addEventListener('click', () => {
        state.order = active && state.order === 'asc' ? 'desc' : 'asc';
        state.sort = column.key;
        load();
      });
      const th = element('th', {}, [button]);
      if (active) th.setAttribute('aria-sort', state.order === 'asc' ? 'ascending' : 'descending');
      return th;
    }),
    element('th', { className: 'actions' }),
  );
}

function renderCell(column, row) {
  const value = row[column.key];
  if (column.key === 'prod') {
    return element('td', {}, [
      element('span', { className: value ? 'badge prod' : 'badge', textContent: value ? 'Бой' : 'Не бой' }),
    ]);
  }
  if (column.type === 'bool') return element('td', { textContent: value ? 'Да' : 'Нет' });
  return element('td', { textContent: value || '', className: column.key === 'title' ? 'title' : '' });
}

function renderBody() {
  body.replaceChildren(
    ...state.rows.map((row) => {
      const edit = element('button', { type: 'button', textContent: 'Изменить' });
      edit.addEventListener('click', () => openEditor(row));
      const remove = element('button', { type: 'button', className: 'danger', textContent: 'Удалить' });
      remove.addEventListener('click', () => removeRow(row));
      return element('tr', {}, [
        ...COLUMNS.map((column) => renderCell(column, row)),
        element('td', { className: 'actions' }, [edit, remove]),
      ]);
    }),
  );
  emptyNote.hidden = state.rows.length > 0;
  counter.textContent = `Записей: ${state.rows.length}`;
}

async function load() {
  const params = new URLSearchParams({ sort: state.sort, order: state.order });
  if (state.q) params.set('q', state.q);
  if (state.prod) params.set('prod', state.prod);
  state.rows = await api(`/api/connections?${params}`);
  renderHead();
  renderBody();
}

// ---------- Правка ----------

function openEditor(row) {
  state.editingId = row ? row.id : null;
  document.getElementById('editor-title').textContent = row ? 'Изменение подключения' : 'Новое подключение';
  editorError.hidden = true;
  editorFields.replaceChildren(
    ...COLUMNS.map((column) => {
      if (column.type === 'bool') {
        const input = element('input', { type: 'checkbox', name: column.key, checked: Boolean(row && row[column.key]) });
        return element('label', { className: 'check' }, [input, column.label]);
      }
      const input = element('input', { name: column.key, value: (row && row[column.key]) || '', maxLength: 500 });
      if (column.key === 'title') input.required = true;
      return element('label', {}, [column.label, input]);
    }),
  );
  editor.showModal();
}

async function saveEditor(event) {
  event.preventDefault();
  const payload = {};
  for (const column of COLUMNS) {
    const input = editorForm.elements[column.key];
    payload[column.key] = column.type === 'bool' ? input.checked : input.value;
  }
  try {
    await api(state.editingId ? `/api/connections/${state.editingId}` : '/api/connections', {
      method: state.editingId ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    editor.close();
    await load();
  } catch (error) {
    editorError.textContent = error.message;
    editorError.hidden = false;
  }
}

async function removeRow(row) {
  if (!confirm(`Удалить подключение «${row.title}»?`)) return;
  await api(`/api/connections/${row.id}`, { method: 'DELETE' });
  await load();
}

// ---------- События ----------

let searchTimer;
document.getElementById('search').addEventListener('input', (event) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = event.target.value.trim();
    load();
  }, 200);
});

document.getElementById('prod-filter').addEventListener('change', (event) => {
  state.prod = event.target.value;
  load();
});

document.getElementById('add').addEventListener('click', () => openEditor(null));
document.getElementById('editor-cancel').addEventListener('click', () => editor.close());
editorForm.addEventListener('submit', saveEditor);

document.getElementById('logout').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

api('/api/me').then((me) => {
  document.getElementById('user-name').textContent = me.login;
});
load();
