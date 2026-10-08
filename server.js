'use strict';
// Реестр подключений к MCP-серверам: вход по логину и паролю, таблица с поиском и сортировкой.
// Без внешних зависимостей — только стандартная библиотека Node.js.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { hashPassword, verifyPassword } = require('./lib/auth');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8787;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COOKIE_SECURE = process.env.COOKIE_SECURE === '1';
// Добавлено: признак работы за обратным прокси (nginx в Docker-стеке).
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const EXAMPLE_FILE = path.join(__dirname, 'connections.example.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_FIELD_LENGTH = 500;
const MAX_LOGIN_FAILURES = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

// Поля подключения. Логинов и паролей к базам здесь нет намеренно:
// всё, чего нет в этом списке, при записи отбрасывается.
const TEXT_FIELDS = ['title', 'infobase', 'name', 'config', 'url', 'cluster', 'dump', 'note'];
const BOOL_FIELDS = ['prod', 'allowExecute'];

const STATIC_FILES = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/login.js': ['login.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

const sessions = new Map(); // токен -> { login, expires }
const loginFailures = new Map(); // IP -> { count, lockedUntil }
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex')); // для проверки несуществующих логинов

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- Хранилище ----------

function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

// Запись через временный файл: при сбое посреди записи старые данные не теряются.
function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadConnections() {
  return readJson(CONNECTIONS_FILE, []);
}

function initStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(CONNECTIONS_FILE)) {
    writeJson(CONNECTIONS_FILE, readJson(EXAMPLE_FILE, []));
  }
  if (!fs.existsSync(USERS_FILE)) {
    // Первый запуск: создаём администратора со случайным паролем и показываем пароль один раз.
    const password = crypto.randomBytes(9).toString('base64url');
    writeJson(USERS_FILE, { users: [{ login: 'admin', passwordHash: hashPassword(password) }] });
    console.log('Создан пользователь: логин admin, пароль ' + password);
    console.log('Сменить пароль: npm run set-password -- admin <новый пароль>');
  }
}

// ---------- Подключения ----------

function normalizeConnection(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'Ожидается объект с полями подключения');
  }
  const result = {};
  for (const field of TEXT_FIELDS) {
    const value = input[field] == null ? '' : String(input[field]).trim();
    if (value.length > MAX_FIELD_LENGTH) {
      throw new HttpError(400, `Поле ${field} длиннее ${MAX_FIELD_LENGTH} символов`);
    }
    result[field] = value;
  }
  for (const field of BOOL_FIELDS) {
    result[field] = input[field] === true;
  }
  if (!result.title) throw new HttpError(400, 'Не заполнено название');
  return result;
}

function compareValues(a, b) {
  if (typeof a === 'boolean' || typeof b === 'boolean') return Number(Boolean(a)) - Number(Boolean(b));
  return String(a || '').localeCompare(String(b || ''), 'ru', { numeric: true, sensitivity: 'base' });
}

// Отбор и сортировка: q — слова через пробел (должны встретиться все), prod — true/false,
// sort — имя поля, order — asc/desc.
function queryConnections(params) {
  let rows = loadConnections();

  const prod = params.get('prod');
  if (prod === 'true' || prod === 'false') {
    rows = rows.filter((row) => Boolean(row.prod) === (prod === 'true'));
  }

  const words = (params.get('q') || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    rows = rows.filter((row) => {
      const text = TEXT_FIELDS.map((field) => row[field] || '').join('\n').toLowerCase();
      return words.every((word) => text.includes(word));
    });
  }

  const sort = params.get('sort') || 'title';
  if (!TEXT_FIELDS.includes(sort) && !BOOL_FIELDS.includes(sort)) {
    throw new HttpError(400, 'Неизвестное поле сортировки');
  }
  const direction = params.get('order') === 'desc' ? -1 : 1;
  rows.sort((a, b) => direction * compareValues(a[sort], b[sort]) || compareValues(a.title, b.title));
  return rows;
}

// ---------- Сессии и вход ----------

function parseCookies(req) {
  const cookies = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return cookies;
}

function getSession(req) {
  const token = parseCookies(req).sid;
  const session = token && sessions.get(token);
  if (!session) return null;
  if (session.expires < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return { token, ...session };
}

function sessionCookie(token, maxAgeSeconds) {
  return `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}` + (COOKIE_SECURE ? '; Secure' : '');
}

function login(req, body) {
  // Изменено: за обратным прокси (TRUST_PROXY=1) адрес клиента берётся из X-Real-IP,
  // иначе все клиенты выглядели бы как один адрес nginx и блокировка входа была бы общей.
  const ip = (TRUST_PROXY && req.headers['x-real-ip']) || req.socket.remoteAddress || '';
  const failure = loginFailures.get(ip);
  if (failure && failure.lockedUntil > Date.now()) {
    throw new HttpError(429, 'Слишком много неудачных попыток, повторите позже');
  }

  const users = readJson(USERS_FILE, { users: [] }).users;
  const user = users.find((item) => item.login === String(body.login || ''));
  // Для несуществующего логина хеш всё равно считается, чтобы время ответа не выдавало, есть ли такой пользователь.
  const ok = verifyPassword(body.password || '', user ? user.passwordHash : DUMMY_HASH) && Boolean(user);

  if (!ok) {
    // Истёкшая блокировка обнуляет счётчик, иначе продолжаем считать неудачи подряд.
    const previous = failure && !failure.lockedUntil ? failure.count : 0;
    const count = previous + 1;
    loginFailures.set(ip, { count, lockedUntil: count >= MAX_LOGIN_FAILURES ? Date.now() + LOGIN_LOCK_MS : 0 });
    throw new HttpError(401, 'Неверный логин или пароль');
  }

  loginFailures.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { login: user.login, expires: Date.now() + SESSION_TTL_MS });
  return token;
}

// ---------- HTTP ----------

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, value, headers = {}) {
  send(res, status, JSON.stringify(value), { 'Content-Type': 'application/json; charset=utf-8', ...headers });
}

function sendFile(res, name, contentType) {
  send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, name)), { 'Content-Type': contentType });
}

function redirect(res, location) {
  send(res, 302, '', { Location: location });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
      reject(new HttpError(415, 'Ожидается Content-Type: application/json'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'Слишком большой запрос'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new HttpError(400, 'Некорректный JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Изменяющие запросы принимаются только со своей страницы (защита от подделки запросов с чужих сайтов).
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    throw new HttpError(403, 'Запрос с постороннего источника');
  }
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname;
  const method = req.method;
  const session = getSession(req);

  if (method !== 'GET' && method !== 'HEAD') checkOrigin(req);

  // Страницы и статика.
  if (method === 'GET' && route === '/') {
    return session ? sendFile(res, 'index.html', 'text/html; charset=utf-8') : redirect(res, '/login');
  }
  if (method === 'GET' && route === '/login') {
    return session ? redirect(res, '/') : sendFile(res, 'login.html', 'text/html; charset=utf-8');
  }
  if (method === 'GET' && STATIC_FILES[route]) {
    return sendFile(res, ...STATIC_FILES[route]);
  }
  if (method === 'GET' && route === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  // Вход и выход.
  if (method === 'POST' && route === '/api/login') {
    const token = login(req, await readBody(req));
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, SESSION_TTL_MS / 1000) });
  }
  if (method === 'POST' && route === '/api/logout') {
    if (session) sessions.delete(session.token);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie('', 0) });
  }

  if (!route.startsWith('/api/')) throw new HttpError(404, 'Не найдено');
  if (!session) throw new HttpError(401, 'Требуется вход');

  if (method === 'GET' && route === '/api/me') {
    return sendJson(res, 200, { login: session.login });
  }
  if (method === 'GET' && route === '/api/connections') {
    return sendJson(res, 200, queryConnections(url.searchParams));
  }
  if (method === 'POST' && route === '/api/connections') {
    const row = { id: crypto.randomUUID(), ...normalizeConnection(await readBody(req)) };
    writeJson(CONNECTIONS_FILE, [...loadConnections(), row]);
    return sendJson(res, 201, row);
  }

  const match = route.match(/^\/api\/connections\/([\w-]+)$/);
  if (match && (method === 'PUT' || method === 'DELETE')) {
    const rows = loadConnections();
    const index = rows.findIndex((row) => row.id === match[1]);
    if (index < 0) throw new HttpError(404, 'Подключение не найдено');
    if (method === 'DELETE') {
      rows.splice(index, 1);
      writeJson(CONNECTIONS_FILE, rows);
      return sendJson(res, 200, { ok: true });
    }
    rows[index] = { id: rows[index].id, ...normalizeConnection(await readBody(req)) };
    writeJson(CONNECTIONS_FILE, rows);
    return sendJson(res, 200, rows[index]);
  }

  throw new HttpError(404, 'Не найдено');
}

initStorage();

http
  .createServer((req, res) => {
    handle(req, res).catch((error) => {
      if (!(error instanceof HttpError)) console.error(error);
      if (res.headersSent) return res.end();
      sendJson(res, error.status || 500, { error: error.status ? error.message : 'Внутренняя ошибка сервера' });
    });
  })
  .listen(PORT, HOST, () => {
    console.log(`Реестр MCP-подключений: http://${HOST}:${PORT}`);
  });
