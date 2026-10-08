'use strict';
// Форма входа.

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  const response = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: form.login.value, password: form.password.value }),
  });
  if (response.ok) {
    location.href = '/';
    return;
  }
  const data = await response.json().catch(() => ({}));
  errorBox.textContent = data.error || 'Не удалось войти';
  errorBox.hidden = false;
  form.password.select();
});
