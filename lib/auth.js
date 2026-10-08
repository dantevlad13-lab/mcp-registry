'use strict';
// Хеширование и проверка паролей (scrypt из стандартной библиотеки Node.js).

const crypto = require('node:crypto');

const KEY_LENGTH = 64;

// Возвращает строку вида "scrypt$<соль hex>$<хеш hex>".
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

// Сравнение за постоянное время, чтобы по длительности ответа нельзя было подбирать хеш.
function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  if (expected.length !== KEY_LENGTH) return false;
  const actual = crypto.scryptSync(String(password), salt, KEY_LENGTH);
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
