// netlify/functions/send-order.js
//
// Приймає POST з даними замовлення (ім'я, телефон, товари, сума)
// і надсилає красиве повідомлення в Telegram-бот через офіційний
// Bot API. Токен і chat_id беруться СТРОГО зі змінних середовища —
// ніде в коді вони не прописані.

const https = require('https');

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    return Promise.reject(new Error('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не задані на сервері'));
  }

  const body = JSON.stringify({
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  });

  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(raw);
        } else {
          reject(new Error(`Telegram API responded with ${res.statusCode}: ${raw}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const name = String(body.name || '').trim();
  const phone = String(body.phone || '').trim();
  const items = Array.isArray(body.items) ? body.items : [];
  const total = Number(body.total);
  const isPrepay = body.type === 'prepay';

  if (!name || !phone) {
    return { statusCode: 400, body: JSON.stringify({ error: "Вкажіть ім'я та телефон" }) };
  }
  if (items.length === 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Кошик порожній' }) };
  }
  if (!total || total <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Некоректна сума' }) };
  }

  const itemsList = items
    .map((it, i) => `${i + 1}. ${escapeHtml(it.name)} — ${it.qty} × ${it.price} ₴`)
    .join('\n');

  const text =
    `${isPrepay ? '🏦 <b>Нове замовлення (передоплата за реквізитами)</b>' : "🛍 <b>Нове замовлення з сайту K17BEAUTY</b>"}\n\n` +
    `👤 <b>Ім'я:</b> ${escapeHtml(name)}\n` +
    `📞 <b>Телефон:</b> ${escapeHtml(phone)}\n\n` +
    `<b>Товари:</b>\n${itemsList}\n\n` +
    `💰 <b>Разом: ${total} ₴</b>` +
    (isPrepay ? `\n\n📋 <b>Спосіб: Передоплата. Очікуйте ручної перевірки.</b>` : '');

  try {
    await sendTelegramMessage(text);
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    };
  } catch (err) {
    console.error('send-order error:', err);
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Не вдалося надіслати повідомлення в Telegram' }),
    };
  }
};