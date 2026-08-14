import { createReadStream, existsSync, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const siteRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 80);
const bitrixWebhookUrl = (process.env.BITRIX_WEBHOOK_URL || '').replace(/\/$/, '');
const categories = {
  client: process.env.BITRIX_CLIENT_CATEGORY_ID || '',
  recruitment: process.env.BITRIX_RECRUITMENT_CATEGORY_ID || ''
};
// Поле сделки «Рекомендация с сайта». Переменная окружения позволяет
// переопределить код для другого портала, а этот код — текущий рабочий портал.
const siteNoteField = (process.env.BITRIX_SITE_NOTE_FIELD || 'UF_CRM_1786668098223').trim();
// Настройки кастомного коннектора Открытой линии. Они намеренно находятся
// только на сервере: токены Bitrix24 никогда не отдаются в браузер.
const openLine = {
  appClientId: (process.env.BITRIX_OPENLINE_APP_CLIENT_ID || '').trim(),
  appClientSecret: (process.env.BITRIX_OPENLINE_APP_CLIENT_SECRET || '').trim(),
  callbackToken: (process.env.BITRIX_OPENLINE_CALLBACK_TOKEN || '').trim(),
  connectorId: (process.env.BITRIX_OPENLINE_CONNECTOR_ID || 'blizkie_site_chat').trim(),
  publicUrl: (process.env.PUBLIC_SITE_URL || '').trim().replace(/\/$/, ''),
  oauthUrl: (process.env.BITRIX_OPENLINE_OAUTH_URL || 'https://oauth.bitrix.info/oauth/token/').trim(),
  storePath: resolve(process.env.CHAT_BRIDGE_STORE_PATH || join(siteRoot, 'data', 'openline-chat.json')),
  timezone: (process.env.CHAT_MANAGER_TIMEZONE || 'Asia/Vladivostok').trim(),
  startHour: Number(process.env.CHAT_MANAGER_START_HOUR || 9),
  endHour: Number(process.env.CHAT_MANAGER_END_HOUR || 20)
};
const connectorIcon = {
  DATA_IMAGE: 'data:image/svg+xml;charset=US-ASCII,%3Csvg%20xmlns%3D%22http%3A//www.w3.org/2000/svg%22%20viewBox%3D%220%200%2070%2071%22%3E%3Crect%20width%3D%2270%22%20height%3D%2271%22%20rx%3D%2216%22%20fill%3D%22%230a7164%22/%3E%3Cpath%20d%3D%22M17%2020h36v25H31l-10%208v-8h-4z%22%20fill%3D%22white%22/%3E%3C/svg%3E',
  COLOR: '#0a7164', SIZE: '100%', POSITION: 'center'
};
let bridgeStorePromise;
let bridgeSaveQueue = Promise.resolve();
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

function cleanChatId(value) {
  return cleanText(value, 100).replace(/[^a-zA-Z0-9_-]/g, '');
}

function isOpenLineConfigured() {
  return Boolean(openLine.appClientId && openLine.appClientSecret && openLine.callbackToken && openLine.publicUrl);
}

function openLineCallbackUrl(pathname) {
  return `${openLine.publicUrl}${pathname}?token=${encodeURIComponent(openLine.callbackToken)}`;
}

function emptyBridgeStore() {
  return { auth: null, lineId: '', sessions: {} };
}

async function getBridgeStore() {
  if (!bridgeStorePromise) {
    bridgeStorePromise = fs.readFile(openLine.storePath, 'utf8')
      .then(raw => {
        const stored = JSON.parse(raw);
        return {
          auth: stored?.auth && typeof stored.auth === 'object' ? stored.auth : null,
          lineId: cleanText(stored?.lineId, 40),
          sessions: stored?.sessions && typeof stored.sessions === 'object' ? stored.sessions : {}
        };
      })
      .catch(error => {
        if (error.code !== 'ENOENT') console.warn('Open line store could not be read:', error.message);
        return emptyBridgeStore();
      });
  }
  return bridgeStorePromise;
}

async function saveBridgeStore() {
  const store = await getBridgeStore();
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [chatId, session] of Object.entries(store.sessions)) {
    if (!session || Number(session.updatedAt || 0) < cutoff) delete store.sessions[chatId];
  }
  const payload = JSON.stringify(store);
  bridgeSaveQueue = bridgeSaveQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(dirname(openLine.storePath), { recursive: true });
      await fs.writeFile(openLine.storePath, payload, { mode: 0o600 });
    });
  return bridgeSaveQueue;
}

function normalizeBitrixAuth(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const domain = cleanText(auth.domain || auth.DOMAIN, 255).replace(/^https?:\/\//, '').replace(/\/$/, '');
  const accessToken = cleanText(auth.access_token || auth.AUTH_ID, 2000);
  if (!domain || !accessToken) return null;
  const now = Math.floor(Date.now() / 1000);
  const rawExpires = Number(auth.expires || auth.AUTH_EXPIRES || auth.expires_in || auth.AUTH_EXPIRES_IN || 0);
  // В обработчиках событий Bitrix отдаёт expires как Unix-время, а при
  // первичной установке локального приложения — как срок в секундах.
  const expires = rawExpires > now ? rawExpires : rawExpires ? now + rawExpires : 0;
  return {
    domain,
    access_token: accessToken,
    refresh_token: cleanText(auth.refresh_token || auth.REFRESH_ID, 2000),
    expires,
    expires_in: rawExpires,
    member_id: cleanText(auth.member_id || auth.MEMBER_ID, 255),
    client_endpoint: cleanText(auth.client_endpoint || auth.CLIENT_ENDPOINT, 1000) || `https://${domain}/rest/`,
    server_endpoint: cleanText(auth.server_endpoint || auth.SERVER_ENDPOINT, 1000)
  };
}

function getBitrixRequestAuth(payload, url) {
  const source = payload && typeof payload === 'object' ? payload : {};
  const nested = source.auth && typeof source.auth === 'object' ? source.auth : {};
  const read = (lower, upper) => nested[lower] ?? nested[upper] ?? source[lower] ?? source[upper] ?? url.searchParams.get(lower) ?? url.searchParams.get(upper);
  return normalizeBitrixAuth({
    domain: read('domain', 'DOMAIN'),
    access_token: read('access_token', 'AUTH_ID'),
    refresh_token: read('refresh_token', 'REFRESH_ID'),
    expires: read('expires', 'AUTH_EXPIRES'),
    expires_in: read('expires_in', 'AUTH_EXPIRES_IN'),
    member_id: read('member_id', 'MEMBER_ID'),
    client_endpoint: read('client_endpoint', 'CLIENT_ENDPOINT'),
    server_endpoint: read('server_endpoint', 'SERVER_ENDPOINT')
  });
}

async function refreshOpenLineAuth(auth) {
  if (!auth?.refresh_token) return auth;
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: openLine.appClientId,
    client_secret: openLine.appClientSecret,
    refresh_token: auth.refresh_token
  });
  const response = await fetch(openLine.oauthUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error_description || body.error || 'Не удалось обновить доступ к Открытой линии');
  return {
    ...auth,
    access_token: cleanText(body.access_token, 2000),
    refresh_token: cleanText(body.refresh_token, 2000) || auth.refresh_token,
    expires: Math.floor(Date.now() / 1000) + Number(body.expires_in || 3600),
    expires_in: Number(body.expires_in || 3600)
  };
}

async function bitrixOpenLineCall(method, payload, authOverride) {
  if (!isOpenLineConfigured()) throw new Error('Коннектор Открытой линии ещё не настроен');
  const store = await getBridgeStore();
  let auth = normalizeBitrixAuth(authOverride) || store.auth;
  if (!auth) throw new Error('Приложение Открытой линии ещё не установлено в Bitrix24');
  const now = Math.floor(Date.now() / 1000);
  if (!authOverride && auth.expires && auth.expires - now < 90) {
    auth = await refreshOpenLineAuth(auth);
    store.auth = auth;
    await saveBridgeStore();
  }
  const endpoint = (auth.client_endpoint || `https://${auth.domain}/rest/`).replace(/\/$/, '');
  const response = await fetch(`${endpoint}/${method}.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ ...payload, auth: auth.access_token })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) throw new Error(body.error_description || body.error || `Bitrix24 ${response.status}`);
  return body.result;
}

function getManagerSchedule() {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: openLine.timezone, hour: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date());
  const hour = Number(parts.find(part => part.type === 'hour')?.value || 0);
  return { online: hour >= openLine.startHour && hour < openLine.endHour, hour };
}

function createExternalChatId() {
  return `bl_${randomBytes(24).toString('base64url')}`;
}

function formatTranscript(transcript, reason, context) {
  const lines = ['Клиент переведён из чат-бота на сайте.', `Причина: ${cleanText(reason, 200) || 'нужен менеджер'}`, '', 'История диалога:'];
  for (const item of Array.isArray(transcript) ? transcript.slice(-80) : []) {
    const role = item?.role === 'bot' ? 'Бот' : item?.role === 'manager' ? 'Менеджер' : 'Клиент';
    const text = cleanText(item?.text, 2500);
    if (text) lines.push(`${role}: ${text}`);
  }
  if (context && typeof context === 'object') {
    const pairs = Object.entries(context)
      .map(([key, value]) => `${cleanText(key, 80)}: ${cleanText(value, 300)}`)
      .filter(Boolean);
    if (pairs.length) lines.push('', 'Контекст, который собрал бот:', pairs.join('; '));
  }
  return lines.join('\n').slice(0, 15000);
}

async function sendVisitorMessage(chatId, text, options = {}) {
  const store = await getBridgeStore();
  const lineId = cleanText(store.lineId, 40);
  if (!lineId) throw new Error('Открытая линия ещё не выбрана для коннектора');
  const session = store.sessions[chatId];
  if (!session) throw new Error('Сессия чата не найдена');
  const messageId = `msg_${randomBytes(12).toString('base64url')}`;
  const result = await bitrixOpenLineCall('imconnector.send.messages', {
    CONNECTOR: openLine.connectorId,
    LINE: Number(lineId),
    MESSAGES: [{
      user: { id: chatId, name: 'Посетитель сайта' },
      message: { id: messageId, date: Math.floor(Date.now() / 1000), text: cleanText(text, 15000) },
      chat: { id: chatId, name: 'Чат сайта «Близкие люди»', url: openLine.publicUrl }
    }]
  });
  const openLineSession = result?.DATA?.RESULT?.[0]?.session;
  if (openLineSession) session.bitrixSession = openLineSession;
  session.updatedAt = Date.now();
  await saveBridgeStore();
  return result;
}

async function startManagerChat(payload) {
  if (!isOpenLineConfigured()) throw new Error('Коннектор Открытой линии ещё не настроен');
  const schedule = getManagerSchedule();
  if (!schedule.online) {
    const error = new Error('Менеджеры сейчас не в сети');
    error.code = 'AFTER_HOURS';
    throw error;
  }
  const store = await getBridgeStore();
  if (!store.auth || !store.lineId) throw new Error('Открытая линия ещё не включена');
  const chatId = createExternalChatId();
  store.sessions[chatId] = { createdAt: Date.now(), updatedAt: Date.now(), managerMessages: [] };
  await saveBridgeStore();
  await sendVisitorMessage(chatId, formatTranscript(payload.transcript, payload.reason, payload.context));
  return { chatId };
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

function buildSiteNote(lead) {
  const form = cleanText(lead.form, 100);
  const leadType = lead.leadType === 'recruitment' ? 'recruitment' : 'client';
  const lines = [];

  if (form === 'care_calculator' && lead.calculation && typeof lead.calculation === 'object') {
    const calculation = lead.calculation;
    lines.push('Расчёт ухода с сайта');
    if (cleanText(calculation.baseLabel, 200)) lines.push(`Услуга: ${cleanText(calculation.baseLabel, 200)}`);
    if (numberOrZero(calculation.quantity)) lines.push(`${cleanText(calculation.qtyLabel, 100) || 'Количество'}: ${numberOrZero(calculation.quantity)}`);
    if (numberOrZero(calculation.shiftPrice)) lines.push(`Стоимость за выход / смену / сутки: ${numberOrZero(calculation.shiftPrice)} ₽`);
    if (numberOrZero(calculation.periodPrice)) lines.push(`Стоимость по выбранному периоду: ${numberOrZero(calculation.periodPrice)} ₽`);
    if (Array.isArray(calculation.breakdown) && calculation.breakdown.length) {
      lines.push(`Условия расчёта: ${calculation.breakdown.map(item => cleanText(item, 300)).filter(Boolean).join('; ')}`);
    }
    if (Array.isArray(lead.selectedSituations) && lead.selectedSituations.length) {
      lines.push(`Ситуация: ${lead.selectedSituations.map(item => cleanText(item, 300)).filter(Boolean).join('; ')}`);
    }
    if (cleanText(calculation.comment, 2000)) lines.push(`Комментарий клиента: ${cleanText(calculation.comment, 2000)}`);
  } else if (leadType === 'recruitment') {
    lines.push('Отклик на работу / партнёрство');
    if (form === 'work_with_us') lines.push('Заявка оставлена через форму «Работать с нами»');
    if (cleanText(lead.message, 2000)) lines.push(`Сообщение: ${cleanText(lead.message, 2000)}`);
  } else {
    lines.push('Заявка с сайта');
    if (form === 'callback_modal') lines.push('Запрос обратного звонка');
    if (form === 'chat_widget') lines.push('Запрос из чата с сайтом');
    if (cleanText(lead.message, 2000)) lines.push(`Сообщение клиента: ${cleanText(lead.message, 2000)}`);
  }

  return lines.join('\n');
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function createBitrixDeal(lead) {
  if (!bitrixWebhookUrl) throw new Error('Интеграция с Bitrix24 ещё не настроена на сервере');
  const leadType = lead.leadType === 'recruitment' ? 'recruitment' : 'client';
  const phone = normalizePhone(lead.phone);
  if (phone.replace(/\D/g, '').length < 10) throw new Error('Некорректный телефон');

  const name = cleanText(lead.name, 120) || 'Без имени';
  const contactId = await bitrixCall('crm.contact.add', {
    fields: {
      NAME: name,
      TYPE_ID: leadType === 'recruitment' ? 'PARTNER' : 'CLIENT',
      PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }]
    }
  });
  const title = cleanText(lead?.bitrix?.title, 200) || (leadType === 'recruitment' ? 'Отклик сиделки с сайта' : 'Заявка на подбор ухода с сайта');
  const fields = { TITLE: `${title} — ${name}`, CONTACT_ID: contactId };
  if (siteNoteField) fields[siteNoteField] = buildSiteNote(lead);
  if (categories[leadType] !== '') fields.CATEGORY_ID = Number(categories[leadType]);
  return bitrixCall('crm.deal.add', { fields });
}

function setNestedValue(target, path, value) {
  let current = target;
  path.forEach((key, index) => {
    const isLast = index === path.length - 1;
    const nextIsArray = /^\d+$/.test(path[index + 1] || '');
    if (isLast) {
      if (Object.hasOwn(current, key)) current[key] = Array.isArray(current[key]) ? current[key].concat(value) : [current[key], value];
      else current[key] = value;
      return;
    }
    if (!current[key] || typeof current[key] !== 'object') current[key] = nextIsArray ? [] : {};
    current = current[key];
  });
}

function parseFormBody(raw) {
  const parsed = {};
  for (const [key, value] of new URLSearchParams(raw)) {
    const path = key.match(/[^\[\]]+/g) || [];
    if (path.length) setNestedValue(parsed, path, value);
  }
  return parsed;
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 262144) request.destroy(new Error('Payload too large'));
    });
    request.on('end', () => {
      try {
        const contentType = String(request.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/x-www-form-urlencoded')) return resolveBody(parseFormBody(body));
        resolveBody(JSON.parse(body || '{}'));
      } catch { reject(new Error('Некорректный запрос')); }
    });
    request.on('error', reject);
  });
}

async function readJson(request) {
  return readBody(request);
}

async function registerOpenLineConnector(auth) {
  const handlerUrl = openLineCallbackUrl('/api/bitrix/openline/handler');
  await bitrixOpenLineCall('imconnector.register', {
    ID: openLine.connectorId,
    NAME: 'Чат сайта «Близкие люди»',
    ICON: connectorIcon,
    ICON_DISABLED: { ...connectorIcon, COLOR: '#a0a0a0' },
    PLACEMENT_HANDLER: handlerUrl
  }, auth);
  await bitrixOpenLineCall('event.bind', {
    event: 'OnImConnectorMessageAdd', handler: handlerUrl
  }, auth);
}

async function handleOpenLineHandler(payload, url) {
  const auth = getBitrixRequestAuth(payload, url);
  const store = await getBridgeStore();
  if (payload.event === 'ONIMCONNECTORMESSAGEADD' && payload?.data?.CONNECTOR === openLine.connectorId) {
    const lineId = cleanText(payload?.data?.LINE, 40) || store.lineId;
    for (const source of Array.isArray(payload?.data?.MESSAGES) ? payload.data.MESSAGES : []) {
      const chatId = cleanChatId(source?.chat?.id);
      const session = store.sessions[chatId];
      if (!session) continue;
      const text = cleanText(source?.message?.text, 12000);
      if (!text) continue;
      const externalMessageId = `operator_${randomBytes(12).toString('base64url')}`;
      session.managerMessages = Array.isArray(session.managerMessages) ? session.managerMessages : [];
      session.managerMessages.push({ id: externalMessageId, text, timestamp: Date.now() });
      session.managerMessages = session.managerMessages.slice(-100);
      session.updatedAt = Date.now();
      await bitrixOpenLineCall('imconnector.send.status.delivery', {
        CONNECTOR: openLine.connectorId,
        LINE: Number(lineId),
        MESSAGES: [{
          im: { chat_id: Number(source?.im?.chat_id), message_id: Number(source?.im?.message_id) },
          message: { id: [externalMessageId], date: Math.floor(Date.now() / 1000) },
          chat: { id: chatId }
        }]
      }, auth);
    }
    await saveBridgeStore();
    return;
  }

  // Bitrix24 opens this handler from the Contact Center when the connector is
  // attached to a line. In that request it gives us the selected LINE.
  if (payload.PLACEMENT_OPTIONS) {
    let options = payload.PLACEMENT_OPTIONS;
    if (typeof options === 'string') {
      try { options = JSON.parse(options); } catch { options = {}; }
    }
    const lineId = cleanText(options?.LINE, 40);
    if (!lineId || !auth) throw new Error('Bitrix24 не передал параметры Открытой линии');
    await bitrixOpenLineCall('imconnector.activate', {
      CONNECTOR: openLine.connectorId,
      LINE: Number(lineId),
      ACTIVE: Number(options?.ACTIVE_STATUS || 0)
    }, auth);
    await bitrixOpenLineCall('imconnector.connector.data.set', {
      CONNECTOR: openLine.connectorId,
      LINE: Number(lineId),
      DATA: {
        ID: `${openLine.connectorId}_line_${lineId}`,
        URL_IM: openLine.publicUrl,
        NAME: 'Чат сайта «Близкие люди»'
      }
    }, auth);
    store.lineId = lineId;
    await saveBridgeStore();
  }
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

  if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/api/bitrix/openline/install') {
    try {
      if (!isOpenLineConfigured()) throw new Error('Сервер ещё не настроен для локального приложения');
      if (url.searchParams.get('token') !== openLine.callbackToken) throw new Error('Недействительный токен обработчика');
      const payload = request.method === 'POST' ? await readBody(request) : {};
      const auth = getBitrixRequestAuth(payload, url);
      if (!auth) throw new Error('Bitrix24 не передал доступ приложению');
      const store = await getBridgeStore();
      store.auth = auth;
      await saveBridgeStore();
      await registerOpenLineConnector(auth);
      return json(response, 200, { ok: true });
    } catch (error) {
      console.error('Open line installation failed:', error.message);
      return json(response, 502, { ok: false, error: 'Не удалось установить коннектор Открытой линии' });
    }
  }

  if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/api/bitrix/openline/handler') {
    try {
      if (!isOpenLineConfigured()) throw new Error('Сервер ещё не настроен для локального приложения');
      if (url.searchParams.get('token') !== openLine.callbackToken) throw new Error('Недействительный токен обработчика');
      await handleOpenLineHandler(request.method === 'POST' ? await readBody(request) : {}, url);
      return json(response, 200, { ok: true });
    } catch (error) {
      console.error('Open line handler failed:', error.message);
      return json(response, 502, { ok: false });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/chat/handoff') {
    try {
      const session = await startManagerChat(await readJson(request));
      return json(response, 201, { ok: true, ...session });
    } catch (error) {
      const afterHours = error.code === 'AFTER_HOURS';
      console.error('Manager handoff failed:', error.message);
      return json(response, afterHours ? 409 : 503, { ok: false, code: afterHours ? 'AFTER_HOURS' : 'UNAVAILABLE' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/chat/message') {
    try {
      const payload = await readJson(request);
      const chatId = cleanChatId(payload.chatId);
      const text = cleanText(payload.text, 12000);
      if (!chatId || !text) throw new Error('Не заполнено сообщение');
      await sendVisitorMessage(chatId, text);
      return json(response, 200, { ok: true });
    } catch (error) {
      console.error('Manager message delivery failed:', error.message);
      return json(response, 503, { ok: false, error: 'Сообщение временно не отправлено' });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/chat/messages') {
    const chatId = cleanChatId(url.searchParams.get('chatId'));
    const after = Number(url.searchParams.get('after') || 0);
    const store = await getBridgeStore();
    const session = store.sessions[chatId];
    if (!session) return json(response, 404, { ok: false });
    const messages = (Array.isArray(session.managerMessages) ? session.managerMessages : [])
      .filter(message => Number(message.timestamp) > after)
      .map(message => ({ id: message.id, text: message.text, timestamp: message.timestamp }));
    return json(response, 200, { ok: true, messages });
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
