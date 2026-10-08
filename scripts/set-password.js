'use strict';
// Создание пользователя или смена пароля: npm run set-password -- <логин> <пароль>

const fs = require('node:fs');
const path = require('node:path');
const { hashPassword } = require('../lib/auth');

const [login, password] = process.argv.slice(2);
if (!login || !password) {
  console.error('Использование: npm run set-password -- <логин> <пароль>');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const file = path.join(dataDir, 'users.json');
fs.mkdirSync(dataDir, { recursive: true });

const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { users: [] };
const user = data.users.find((item) => item.login === login);
if (user) {
  user.passwordHash = hashPassword(password);
} else {
  data.users.push({ login, passwordHash: hashPassword(password) });
}
fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');

console.log(user ? `Пароль пользователя ${login} изменён` : `Пользователь ${login} создан`);
console.log('Уже открытые сессии действуют до перезапуска сервиса.');
