import { createReadStream, existsSync, promises as fs } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 80);
const bitrixWebhookUrl = (process.env.BITRIX_WEBHOOK_URL || '').replace(/\/$/, '');
const categories = {
  client: process.env.BITRIX_CLIENT_CATEGORY_ID || '',
  recruitment: process.env.BITRIX_RECRUITMENT_CATEGORY_ID || ''
};
const mimeTypes = {
  '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.mp4': 'video/mp4', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp'
};

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

function cleanText(value, limit = 4000) {
  return String(value ?? '').trim().replace(/\0/g, '').slice(0, limit);
}

function normalizePhone(value) {
  return cleanText(value, 40).replace(/[^0-9+]/g, '');
}

async function bitrixCall(method, payload) {
  const response = await fetch(`${bitrixWebhookUrl}/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error_description || `Bitrix24 ${response.status}`);
  return body.result;
}

function buildComment(lead) {
  const details = lead.summary || JSON.stringify({
    selectedSituations: lead.selectedSituations || [],
    calculation: lead.calculation || {},
    comment: lead.comment || ''
  }, null, 2);
  return [
    `Форма: ${cleanText(lead.form, 100)}`,
    `Источник: ${cleanText(lead.source, 200)}`,
    `Страница: ${cleanText(lead.page, 1000)}`,
    '',
    details
  ].join('\n');
}

async function createBitrixDeal(lead) {
  if (!bitrixWebhookUrl) throw new Error('Интеграция с Bitrix24 ещё не настроена на сервере');
  const leadType = lead.leadType === 'recruitment' ? 'recruitment' : 'client';
  const phone = normalizePhone(lead.phone);
  if (phone.replace(/\D/g, '').length < 10) throw new Error('Некорректный телефон');

  const name = cleanText(lead.name, 120) || 'Без имени';
  const contactId = await bitrixCall('crm.contact.add', {
    fields: { NAME: name, PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }] }
  });
  const title = cleanText(lead?.bitrix?.title, 200) || (leadType === 'recruitment' ? 'Отклик сиделки с сайта' : 'Заявка на подбор ухода с сайта');
  const fields = { TITLE: `${title} — ${name}`, CONTACT_ID: contactId, COMMENTS: buildComment(lead) };
  if (categories[leadType] !== '') fields.CATEGORY_ID = Number(categories[leadType]);
  return bitrixCall('crm.deal.add', { fields });
}

function readJson(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 262144) request.destroy(new Error('Payload too large'));
    });
    request.on('end', () => {
      try { resolveBody(JSON.parse(body || '{}')); } catch { reject(new Error('Некорректный JSON')); }
    });
    request.on('error', reject);
  });
}

createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });

  if (request.method === 'POST' && url.pathname === '/api/leads') {
    try {
      const lead = await readJson(request);
      const dealId = await createBitrixDeal(lead);
      return json(response, 201, { ok: true, dealId });
    } catch (error) {
      console.error('Lead delivery failed:', error.message);
      return json(response, 502, { ok: false, error: 'Заявка временно не отправлена' });
    }
  }

  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Method not allowed' });
  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = normalize(join(siteRoot, requestedPath));
  if (!filePath.startsWith(siteRoot) || !existsSync(filePath)) return json(response, 404, { error: 'Not found' });
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) return json(response, 404, { error: 'Not found' });
  response.writeHead(200, {
    'Content-Type': mimeTypes[extname(filePath).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': extname(filePath) === '.html' ? 'no-cache' : 'public, max-age=604800'
  });
  if (request.method === 'HEAD') return response.end();
  createReadStream(filePath).pipe(response);
}).listen(port, () => console.log(`Site listening on :${port}`));
