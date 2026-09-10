// netlify/functions/create-payment.js
//
// Викликається, коли клієнт обирає "Оплата карткою". Створює рахунок
// через Monobank Acquiring API (Plata by Mono) і повертає pageUrl —
// адресу сторінки оплати, куди фронтенд одразу перенаправляє клієнта.
// Приватний токен (MONO_TOKEN) НІКОЛИ не потрапляє на фронтенд.
//
// В цей момент повідомлення в Telegram ЩЕ НЕ надсилається — це станеться
// пізніше, коли Monobank підтвердить оплату через mono-webhook.js.
//
// Примітка: поле кошика в Monobank називається "basketOrder" і лежить
// ВСЕРЕДИНІ merchantPaymInfo (не окреме поле "basket" у корені) —
// це підтверджено офіційною документацією Monobank Acquiring API.

const https = require('https');

function monoRequest(path, token, bodyObj) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(bodyObj);
    const options = {
      hostname: 'api.monobank.ua',
      path,
      method: 'POST',
      headers: {
        'X-Token': token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(raw); } catch (e) { parsed = raw; }
        resolve({ statusCode: res.statusCode, body: parsed, raw });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const MONO_TOKEN = process.env.MONO_TOKEN;
  // Реальна адреса сайту — використовується як резервний варіант, якщо
  // змінна середовища SITE_URL не задана на Netlify.
  const SITE_URL = process.env.SITE_URL || 'https://shop.k17beauty.com.ua';

  if (!MONO_TOKEN) {
    console.error('MONO_TOKEN is not set in environment variables');
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'MONO_TOKEN is not configured on the server' }),
    };
  }

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch (e) {
    console.error('create-payment: invalid JSON body from frontend:', event.body);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const amount = Number(body.amount); // сума в гривнях, з фронтенду
  if (!amount || amount <= 0) {
    console.error('create-payment: invalid amount received:', body.amount);
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid amount' }) };
  }

  const items = Array.isArray(body.items) ? body.items : [];

  // basketOrder — склад чека, суми в копійках (ціле число, обов'язково для Monobank).
  // Якщо з якоїсь причини фронтенд не передав жодного товару — підставляємо
  // один узагальнений рядок на всю суму, щоб basketOrder ніколи не був порожнім
  // (порожній кошик — одна з найчастіших причин 400 від Monobank).
  let basketOrder = items
    .filter(i => i && i.name)
    .map(i => {
      const qty = Number(i.qty) > 0 ? Number(i.qty) : 1;
      const unitSumKopecks = Math.round(Number(i.price) * 100);
      return {
        name: String(i.name).slice(0, 100),
        qty,
        sum: unitSumKopecks * qty, // ціле число, копійки
        unit: 'шт.',
      };
    });

  const amountKopecks = Math.round(amount * 100); // ціле число, копійки

  if (basketOrder.length === 0) {
    basketOrder = [{
      name: 'Замовлення K17BEAUTY',
      qty: 1,
      sum: amountKopecks,
      unit: 'шт.',
    }];
  }

  const orderId = `k17-${Date.now()}`;

  const payload = {
    amount: amountKopecks,
    ccy: 980, // UAH
    merchantPaymInfo: {
      reference: orderId,
      destination: 'Оплата замовлення K17BEAUTY',
      basketOrder,
    },
    redirectUrl: `${SITE_URL}/?payment=success`,
    webHookUrl: `${SITE_URL}/.netlify/functions/mono-webhook`,
    validity: 3600, // рахунок дійсний 1 годину
  };

  console.log('create-payment: sending payload to Monobank:', JSON.stringify(payload));

  try {
    const result = await monoRequest('/api/merchant/invoice/create', MONO_TOKEN, payload);

    if (result.statusCode < 200 || result.statusCode >= 300) {
      // Тут буде видно ТОЧНУ причину відмови від Monobank (текст помилки з їхньої відповіді)
      console.error('Monobank responded with error status:', result.statusCode);
      console.error('Monobank response body:', result.raw);
      return {
        statusCode: 502,
        body: JSON.stringify({
          error: 'Monobank rejected the request',
          monobankStatus: result.statusCode,
          monobankResponse: result.body,
        }),
      };
    }

    if (!result.body || !result.body.pageUrl) {
      console.error('Monobank returned 200 but no pageUrl:', result.raw);
      throw new Error('Monobank did not return pageUrl');
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageUrl: result.body.pageUrl, invoiceId: result.body.invoiceId }),
    };
  } catch (err) {
    console.error('create-payment: unexpected error:', err.message);
    console.error('Payload that was sent to Monobank:', JSON.stringify(payload));
    return {
      statusCode: 502,
      body: JSON.stringify({ error: 'Не вдалося створити рахунок Monobank' }),
    };
  }
};
