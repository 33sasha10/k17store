// netlify/functions/mono-webhook.js
//
// Сюди Monobank надсилає ПРИХОВАНЕ (server-to-server) підтвердження
// після зміни статусу рахунку — саме на цю адресу вказує webHookUrl
// у create-payment.js. Підпис (заголовок x-sign) перевіряється через
// публічний ключ мерчанта (GET /api/merchant/pubkey), щоб виключити
// підроблені запити.
//
// Ця функція відповідає ТІЛЬКИ за реальні підтвердження оплати карткою.
// Для "Передоплати за реквізитами" повідомлення в Telegram шле інша,
// вже перевірена функція — send-order.js (та сама, що для звичайних
// заявок, лише з позначкою type:"prepay").

const https = require('https');
const crypto = require('crypto');

let cachedPubKey = null; // тримається в пам'яті, поки функція "тепла"

function monoGet(path, token) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'api.monobank.ua',
      path,
      method: 'GET',
      headers: { 'X-Token': token },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(Buffer.concat(chunks));
        } else {
          reject(new Error(`Monobank pubkey request failed: ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getPubKey(token, forceRefresh) {
  if (cachedPubKey && !forceRefresh) return cachedPubKey;
  const raw = await monoGet('/api/merchant/pubkey', token);
  let base64Key;
  try {
    base64Key = JSON.parse(raw.toString('utf8')); // тіло — base64-рядок у лапках
  } catch (e) {
    base64Key = raw.toString('utf8').trim();
  }
  const derBuffer = Buffer.from(base64Key, 'base64');
  cachedPubKey = crypto.createPublicKey({ key: derBuffer, format: 'der', type: 'spki' });
  return cachedPubKey;
}

async function verifySignature(rawBody, signatureB64, token) {
  const signature = Buffer.from(signatureB64, 'base64');
  const bodyBuffer = Buffer.from(rawBody, 'utf8');

  let pubKey = await getPubKey(token, false);
  let ok = crypto.verify('sha256', bodyBuffer, pubKey, signature);
  if (!ok) {
    // ключ міг ротуватись на боці Monobank — пробуємо оновити й перевірити ще раз
    pubKey = await getPubKey(token, true);
    ok = crypto.verify('sha256', bodyBuffer, pubKey, signature);
  }
  return ok;
}

function sendTelegramMessage(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID не задані — пропускаю сповіщення');
    return Promise.resolve();
  }

  const body = JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' });
  const options = {
    hostname: 'api.telegram.org',
    path: `/bot${token}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };

  return new Promise((resolve) => {
    const req = https.request(options, (res) => {
      res.on('data', () => {});
      res.on('end', resolve);
    });
    req.on('error', (err) => { console.error('Telegram error:', err); resolve(); });
    req.write(body);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const MONO_TOKEN = process.env.MONO_TOKEN;
  if (!MONO_TOKEN) {
    return { statusCode: 500, body: 'Server not configured' };
  }

  const headers = event.headers || {};
  const signatureB64 = headers['x-sign'] || headers['X-Sign'];
  const rawBody = event.body || '';

  if (!signatureB64) {
    return { statusCode: 400, body: 'Missing x-sign header' };
  }

  let verified = false;
  try {
    verified = await verifySignature(rawBody, signatureB64, MONO_TOKEN);
  } catch (err) {
    console.error('Signature verification error:', err);
  }

  // КРИТИЧНО: без валідного підпису не довіряємо запиту —
  // інакше будь-хто міг би підробити "оплата успішна"
  if (!verified) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  const { status, invoiceId, amount, reference } = payload;

  if (status === 'success') {
    const uah = (Number(amount) / 100).toFixed(2);
    await sendTelegramMessage(
      `✅ <b>Оплату карткою отримано!</b>\n\n` +
      `Рахунок: ${invoiceId}\n` +
      `Замовлення: ${reference || '—'}\n` +
      `Сума: ${uah} грн`
    );
  } else if (status === 'failure' || status === 'reversed' || status === 'expired') {
    await sendTelegramMessage(
      `⚠️ Оплата карткою не завершена\nРахунок: ${invoiceId}\nСтатус: ${status}`
    );
  }
  // інші статуси (created, processing, hold) — ігноруємо, чекаємо фінального

  // Monobank очікує 200 у відповідь, інакше повторить запит до 3 разів
  return { statusCode: 200, body: 'OK' };
};