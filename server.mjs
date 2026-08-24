import { createReadStream, existsSync, promises as fs, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseNextManager, isSubstitutionActive, parseIdList } from './crm-automation.mjs';

const siteRoot = resolve(fileURLToPath(new URL('.', import.meta.url)));
const port = Number(process.env.PORT || 80);
// Dokploy создаёт .env во время сборки. У уже работающего Docker-сервиса
// может остаться одноимённая устаревшая системная переменная, поэтому для
// каталога сознательно читаем значение из этого файла раньше process.env.
function envFileValue(name) {
  try {
    const prefix = `${name}=`;
    const line = readFileSync(join(siteRoot, '.env'), 'utf8')
      .split(/\r?\n/)
      .find(item => item.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : '';
  } catch {
    return '';
  }
}
// В Dokploy старое имя переменной может оставаться в уже созданном сервисе.
// Отдельная переменная для каталога позволяет обновлять эту интеграцию без
// затрагивания других подключений Bitrix (например, Открытой линии).
const bitrixWebhookUrl = (envFileValue('BITRIX_CATALOG_WEBHOOK_URL') || process.env.BITRIX_CATALOG_WEBHOOK_URL || process.env.BITRIX_WEBHOOK_URL || '').replace(/\/$/, '');
const categories = {
  client: process.env.BITRIX_CLIENT_CATEGORY_ID || '',
  recruitment: process.env.BITRIX_RECRUITMENT_CATEGORY_ID || ''
};
// Поле сделки «Рекомендация с сайта». Переменная окружения позволяет
// переопределить код для другого портала, а этот код — текущий рабочий портал.
const siteNoteField = (process.env.BITRIX_SITE_NOTE_FIELD || 'UF_CRM_1786668098223').trim();
// Многострочное поле сделки «Расчёт из калькулятора». Это снимок исходного
// запроса посетителя: он остаётся менеджеру для сверки с товарами сделки.
const calculatorDetailsField = (process.env.BITRIX_CALCULATOR_DETAILS_FIELD || 'UF_CRM_1787042892').trim();
const calculatorCatalogId = Number(process.env.BITRIX_CALCULATOR_CATALOG_ID || 24);
// Товары, для которых калькулятору нужны специальные правила: почасовой
// формат, автоматические надбавки и особые минимальные сроки. Их ID
// сохранены только для обратной совместимости с уже настроенным каталогом.
const managerIds = parseIdList(process.env.BITRIX_MANAGER_IDS || '12,16,18');
const fallbackManagerId = Number(process.env.BITRIX_FALLBACK_MANAGER_ID || 1);
const routingStorePath = resolve(process.env.CRM_ROUTING_STORE_PATH || join(siteRoot, 'data', 'crm-routing.json'));
const substitutionFields = {
  original: (process.env.BITRIX_SUBSTITUTION_ORIGINAL_FIELD || 'UF_CRM_SUBSTITUTION_ORIGINAL').trim(),
  replacement: (process.env.BITRIX_SUBSTITUTION_MANAGER_FIELD || 'UF_CRM_SUBSTITUTION_MANAGER').trim(),
  until: (process.env.BITRIX_SUBSTITUTION_UNTIL_FIELD || 'UF_CRM_SUBSTITUTION_UNTIL').trim(),
  comment: (process.env.BITRIX_SUBSTITUTION_COMMENT_FIELD || 'UF_CRM_SUBSTITUTION_COMMENT').trim()
};
const calculatorProductIds = {
  hourly_2: 20, hourly_3: 24, hourly_4: 28, hourly_5: 32, hourly_6: 36,
  hourly_7: 40, hourly_8: 44, hourly_9: 48, hourly_10: 52, hourly_11: 56, hourly_12: 60,
  patronage: 64, night_home: 72, day_home: 76, hospital_day: 80, hospital_night: 84,
  hospital_24: 88, live_in: 92, surcharge_one_time: 96, surcharge_less_than_five: 100,
  surcharge_urgent: 104, surcharge_experienced: 108, surcharge_two_people: 112,
  surcharge_complex: 116, surcharge_pet: 120, surcharge_weekend: 124,
  surcharge_holiday_30: 128, surcharge_holiday_100: 132, one_time: 136
};
const calculatorBaseKeys = new Set([
  'patronage', 'one_time', 'night_home', 'day_home', 'hospital_day',
  'hospital_night', 'hospital_24', 'live_in'
]);
let calculatorCatalogCache = { expiresAt: 0, value: null };
let routingStorePromise;
let routingSaveQueue = Promise.resolve();
let managerAssignmentQueue = Promise.resolve();
// Настройки кастомного коннектора Открытой линии. Они намеренно находятся
// только на сервере: токены Bitrix24 никогда не отдаются в браузер.
const openLine = {
  appClientId: (process.env.BITRIX_OPENLINE_APP_CLIENT_ID || '').trim(),
  appClientSecret: (process.env.BITRIX_OPENLINE_APP_CLIENT_SECRET || '').trim(),
  callbackToken: (process.env.BITRIX_OPENLINE_CALLBACK_TOKEN || '').trim(),
  connectorId: (process.env.BITRIX_OPENLINE_CONNECTOR_ID || 'blizkie_site_chat').trim(),
  publicUrl: (process.env.PUBLIC_SITE_URL || '').trim().replace(/\/$/, ''),
  oauthUrl: (process.env.BITRIX_OPENLINE_OAUTH_URL || 'https://oauth.bitrix.info/oauth/token/').trim(),
  storePath: resolve(process.env.CHAT_BRIDGE_STORE_PATH || join(siteRoot, 'data', 'openline-chat.json'))
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

// Bitrix24 передаёт POST form-data с индексами вроде MESSAGES[0]. После
// разбора формы это объект { 0: {...} }, а не JavaScript-массив. Нормализуем
// оба представления, иначе ответы операторов тихо теряются на входе.
function indexedValues(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value === 'object') return Object.values(value);
  return [];
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
  const messageResult = result?.DATA?.RESULT?.[0];
  if (result?.SUCCESS === false || messageResult?.SUCCESS === false) {
    const details = Array.isArray(messageResult?.ERRORS) ? messageResult.ERRORS.join('; ') : '';
    throw new Error(details || 'Bitrix24 не принял сообщение для Открытой линии');
  }
  const openLineSession = messageResult?.session;
  if (openLineSession) session.bitrixSession = openLineSession;
  session.updatedAt = Date.now();
  await saveBridgeStore();
  return result;
}

async function startManagerChat(payload) {
  if (!isOpenLineConfigured()) throw new Error('Коннектор Открытой линии ещё не настроен');
  const store = await getBridgeStore();
  if (!store.auth || !store.lineId) throw new Error('Открытая линия ещё не включена');
  const chatId = createExternalChatId();
  store.sessions[chatId] = { createdAt: Date.now(), updatedAt: Date.now(), managerMessages: [] };
  await saveBridgeStore();
  await sendVisitorMessage(chatId, formatTranscript(payload.transcript, payload.reason, payload.context));
  return { chatId };
}

function isOperatorMessage(message, users) {
  const senderId = cleanText(message?.senderid, 40);
  const sender = users?.[senderId];
  // Сообщения клиента в Открытой линии имеют технического пользователя
  // коннектора. Оставляем только реальные сообщения сотрудников.
  return Boolean(
    senderId &&
    /^\d+$/.test(senderId) &&
    senderId !== '0' &&
    sender &&
    sender.connector !== true &&
    cleanText(sender.externalAuthId, 100) !== 'imconnector'
  );
}

async function syncManagerMessages(chatId) {
  const store = await getBridgeStore();
  const session = store.sessions[chatId];
  const bitrixSession = session?.bitrixSession;
  if (!session || !bitrixSession?.CHAT_ID) return;

  const now = Date.now();
  // Виджет опрашивает сервер часто; не расходуем лимит REST Битрикс24 чаще,
  // чем один раз в две секунды для одного живого диалога.
  if (now - Number(session.lastManagerSyncAt || 0) < 2000) return;
  session.lastManagerSyncAt = now;

  try {
    const history = await bitrixOpenLineCall('imopenlines.session.history.get', {
      SESSION_ID: Number(bitrixSession.ID) || undefined,
      CHAT_ID: Number(bitrixSession.CHAT_ID)
    });
    const users = history?.users && typeof history.users === 'object' ? history.users : {};
    const knownIds = new Set(Array.isArray(session.managerBitrixMessageIds) ? session.managerBitrixMessageIds.map(String) : []);
    const messages = indexedValues(history?.message)
      .filter(message => isOperatorMessage(message, users))
      .sort((left, right) => Number(left?.id || 0) - Number(right?.id || 0));

    session.managerMessages = Array.isArray(session.managerMessages) ? session.managerMessages : [];
    for (const message of messages) {
      const messageId = cleanText(message?.id, 100);
      const text = cleanText(message?.text, 12000);
      if (!messageId || !text || knownIds.has(messageId)) continue;
      const timestamp = Date.parse(cleanText(message?.date, 100)) || now;
      session.managerMessages.push({ id: `operator_${messageId}`, text, timestamp });
      knownIds.add(messageId);
    }
    session.managerBitrixMessageIds = Array.from(knownIds).slice(-300);
    session.managerMessages = session.managerMessages.slice(-100);
    session.updatedAt = now;
    await saveBridgeStore();
  } catch (error) {
    console.warn('Open Line manager history sync failed:', error.message);
    await saveBridgeStore();
  }
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

async function getRoutingStore() {
  if (!routingStorePromise) {
    routingStorePromise = fs.readFile(routingStorePath, 'utf8')
      .then(raw => {
        const value = JSON.parse(raw);
        return { lastManagerId: Number(value?.lastManagerId) || 0 };
      })
      .catch(error => {
        if (error.code !== 'ENOENT') console.warn('CRM routing store could not be read:', error.message);
        return { lastManagerId: 0 };
      });
  }
  return routingStorePromise;
}

async function saveRoutingStore() {
  const store = await getRoutingStore();
  const payload = JSON.stringify(store);
  routingSaveQueue = routingSaveQueue
    .catch(() => undefined)
    .then(async () => {
      await fs.mkdir(dirname(routingStorePath), { recursive: true });
      await fs.writeFile(routingStorePath, payload, { mode: 0o600 });
    });
  return routingSaveQueue;
}

async function getActiveManagerIds() {
  if (!managerIds.length) return [];
  try {
    const users = indexedValues(await bitrixCall('user.get', {}));
    return users
      .filter(user => user?.ACTIVE !== false && user?.ACTIVE !== 'N' && managerIds.includes(Number(user?.ID)))
      .map(user => Number(user.ID));
  } catch (error) {
    // У старого вебхука может не быть user_brief. Конфигурация очереди всё
    // равно остаётся рабочей, а активность проверится после расширения прав.
    console.warn('Manager activity check skipped:', error.message);
    return managerIds;
  }
}

async function getManagersOnSubstitution(now = new Date()) {
  if (!managerIds.length) return [];
  try {
    const deals = indexedValues(await bitrixCall('crm.deal.list', {
      order: { ID: 'ASC' },
      filter: { CLOSED: 'N' },
      select: ['ID', substitutionFields.original, substitutionFields.until]
    }));
    return [...new Set(deals
      .filter(deal => isSubstitutionActive(deal?.[substitutionFields.until], now))
      .map(deal => Number(String(deal?.[substitutionFields.original] || '').replace(/\D/g, '')))
      .filter(id => managerIds.includes(id)))];
  } catch (error) {
    // Поля появляются после обновления локального приложения. До этого
    // очередь работает без фильтра по отпускам и не блокирует приём заявок.
    console.warn('Manager substitution check skipped:', error.message);
    return [];
  }
}

async function selectNextAssignedManager() {
  if (!managerIds.length) return 0;
  const [activeIds, unavailableIds, store] = await Promise.all([
    getActiveManagerIds(),
    getManagersOnSubstitution(),
    getRoutingStore()
  ]);
  const managerId = chooseNextManager(managerIds, activeIds, unavailableIds, store.lastManagerId);
  if (!managerId) {
    if (Number.isInteger(fallbackManagerId) && fallbackManagerId > 0) return fallbackManagerId;
    throw new Error('В очереди новых заявок нет доступных менеджеров');
  }
  store.lastManagerId = managerId;
  await saveRoutingStore();
  return managerId;
}

function nextAssignedManager() {
  const assignment = managerAssignmentQueue.then(() => selectNextAssignedManager());
  managerAssignmentQueue = assignment.catch(() => undefined);
  return assignment;
}

async function restoreExpiredSubstitutions() {
  if (!bitrixWebhookUrl) return;
  let deals;
  try {
    deals = indexedValues(await bitrixCall('crm.deal.list', {
      order: { ID: 'ASC' },
      filter: { CLOSED: 'N' },
      select: ['ID', 'ASSIGNED_BY_ID', substitutionFields.original, substitutionFields.replacement, substitutionFields.until]
    }));
  } catch (error) {
    console.warn('Expired substitutions check skipped:', error.message);
    return;
  }
  const now = new Date();
  for (const deal of deals) {
    if (isSubstitutionActive(deal?.[substitutionFields.until], now)) continue;
    const originalId = Number(String(deal?.[substitutionFields.original] || '').replace(/\D/g, ''));
    if (!originalId) continue;
    const dealId = Number(deal.ID);
    await bitrixCall('crm.deal.update', {
      id: dealId,
      fields: {
        ASSIGNED_BY_ID: originalId,
        [substitutionFields.original]: '',
        [substitutionFields.replacement]: '',
        [substitutionFields.until]: '',
        [substitutionFields.comment]: ''
      }
    });
    await bitrixCall('crm.timeline.comment.add', {
      fields: {
        ENTITY_ID: dealId,
        ENTITY_TYPE: 'deal',
        COMMENT: 'Срок замещения завершён. Исходный ответственный восстановлен автоматически.'
      }
    });
  }
}

function currencyNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) / 100 : 0;
}

function percentageFromProductName(name) {
  const match = cleanText(name, 300).match(/\+(\d+(?:[.,]\d+)?)\s*%/);
  return match ? Number(match[1].replace(',', '.')) : 0;
}

function productPictureAvailable(product) {
  return Boolean(product?.PREVIEW_PICTURE || product?.DETAIL_PICTURE);
}

function dynamicCareKey(productId) {
  return `care_${Number(productId)}`;
}

function dynamicCareMarker(product) {
  const externalCode = cleanText(product?.CODE || product?.XML_ID, 100).toLowerCase();
  if (/^calculator_care_[a-z0-9_-]+$/i.test(externalCode)) return externalCode;
  // Некоторые версии CRM Product API не отдают «Внешний код» в списке,
  // хотя он сохранён в интерфейсе. В этом случае работает тот же маркер
  // отдельной строкой в описании товара.
  const description = cleanText(product?.DESCRIPTION, 500).toLowerCase();
  const match = description.match(/(?:^|\n)\s*\[?(calculator_care_[a-z0-9_-]+)\]?\s*(?:\n|$)/i);
  return match ? match[1].toLowerCase() : '';
}

function visibleProductDescription(product) {
  return cleanText(product?.DESCRIPTION, 500)
    .replace(/(?:^|\n)\s*\[?calculator_care_[a-z0-9_-]+\]?\s*(?=\n|$)/ig, '')
    .trim();
}

function isDynamicCareProduct(product, legacyIds) {
  const id = Number(product?.ID);
  const name = cleanText(product?.NAME, 300);
  const code = dynamicCareMarker(product);
  if (!id || !name || legacyIds.has(id) || product?.ACTIVE === 'N') return false;
  // В каталоге есть служебные, тестовые и разовые позиции. Поэтому новый
  // тип ухода попадает на публичный сайт только по явному маркеру, а не по
  // одному названию. Менеджер указывает его один раз в поле «Символьный код»
  // карточки товара: calculator_care_<любой_код>.
  return /^calculator_care_[a-z0-9_-]+$/i.test(code);
}

async function getCalculatorCatalog(force = false) {
  if (!force && calculatorCatalogCache.value && calculatorCatalogCache.expiresAt > Date.now()) {
    return calculatorCatalogCache.value;
  }

  const products = await bitrixCall('crm.product.list', {
    order: { ID: 'ASC' },
    filter: { CATALOG_ID: calculatorCatalogId },
    select: ['ID', 'NAME', 'PRICE', 'CURRENCY_ID', 'CODE', 'XML_ID', 'DESCRIPTION', 'ACTIVE', 'PREVIEW_PICTURE', 'DETAIL_PICTURE']
  });
  const byId = new Map(indexedValues(products).map(product => [Number(product?.ID), product]));
  const missing = Object.entries(calculatorProductIds)
    .filter(([, id]) => !byId.has(id))
    .map(([key]) => key);
  if (missing.length) throw new Error(`В каталоге Bitrix24 не найдены позиции калькулятора: ${missing.join(', ')}`);

  const itemFromProduct = (key, product) => ({
    id: Number(product?.ID),
    key,
    name: cleanText(product?.NAME, 300),
    price: currencyNumber(product?.PRICE),
    currency: cleanText(product?.CURRENCY_ID, 10) || 'RUB',
    percent: percentageFromProductName(product?.NAME),
    description: visibleProductDescription(product),
    imageUrl: productPictureAvailable(product) ? `/api/calculator/catalog/image/${Number(product?.ID)}` : ''
  });

  const items = Object.fromEntries(Object.entries(calculatorProductIds).map(([key, id]) => {
    const product = byId.get(id);
    return [key, itemFromProduct(key, product)];
  }));

  const legacyIds = new Set(Object.values(calculatorProductIds));
  const dynamicCarePlans = indexedValues(products)
    .filter(product => isDynamicCareProduct(product, legacyIds))
    .map(product => itemFromProduct(dynamicCareKey(product.ID), product));
  dynamicCarePlans.forEach(product => { items[product.key] = product; });

  const catalog = {
    catalogId: calculatorCatalogId,
    fetchedAt: new Date().toISOString(),
    items,
    // Эти товары фронтенд добавляет к карточкам ухода сам. Для знакомых
    // форматов остаются фирменные иллюстрации и специальные правила; новая
    // карточка использует картинку из товара Bitrix24.
    dynamicCarePlans
  };
  calculatorCatalogCache = { value: catalog, expiresAt: Date.now() + 60_000 };
  return catalog;
}

function catalogProductFromResult(result) {
  return result?.product || result?.PRODUCT || result || {};
}

async function getCalculatorProductImage(productId) {
  const result = await bitrixCall('catalog.product.get', { id: Number(productId) });
  const product = catalogProductFromResult(result);
  const picture = product?.previewPicture || product?.PREVIEW_PICTURE || product?.detailPicture || product?.DETAIL_PICTURE;
  const downloadPath = cleanText(picture?.urlMachine || picture?.url, 2000);
  if (!downloadPath) return null;

  const params = new URL(downloadPath, new URL(bitrixWebhookUrl).origin).searchParams;
  const downloadUrl = new URL(`${bitrixWebhookUrl}/catalog.product.download`);
  for (const [key, value] of params.entries()) downloadUrl.searchParams.set(key, value);
  const response = await fetch(downloadUrl);
  if (!response.ok) throw new Error(`Bitrix24 не отдал картинку товара (${response.status})`);
  const contentType = cleanText(response.headers.get('content-type'), 100).toLowerCase();
  if (!contentType.startsWith('image/')) throw new Error('Bitrix24 вернул некорректную картинку товара');
  return { contentType, body: Buffer.from(await response.arrayBuffer()) };
}

function calculatorBaseKey(calculation, catalog) {
  const plan = cleanText(calculation?.plan, 50);
  if (plan === 'hourly') {
    const hours = Math.min(12, Math.max(2, Math.round(Number(calculation?.hours) || 2)));
    return `hourly_${hours}`;
  }
  if (catalog?.items?.[plan] && calculatorBaseKeys.has(plan) === false && plan.startsWith('care_')) return plan;
  return ['patronage', 'one_time', 'night_home', 'day_home', 'hospital_day', 'hospital_night', 'hospital_24', 'live_in'].includes(plan)
    ? plan
    : 'hourly_2';
}

function calculatorQuantity(calculation, baseKey) {
  const min = baseKey === 'live_in' ? 16 : 1;
  const max = baseKey === 'one_time' ? 1 : 30;
  return Math.min(max, Math.max(min, Math.round(Number(calculation?.quantity) || min)));
}

function requestedCheckbox(calculation, name) {
  return Boolean(calculation?.surcharges && calculation.surcharges[name]);
}

function addPercentageRow(rows, catalog, key, quantity, basePrice) {
  const product = catalog.items[key];
  if (!product?.percent) throw new Error(`У товара «${product?.name || key}» не указана процентная надбавка в названии`);
  rows.push({
    PRODUCT_ID: product.id,
    PRICE: currencyNumber(basePrice * product.percent / 100),
    QUANTITY: quantity,
    SORT: rows.length + 1
  });
}

function buildCalculatorProductRows(calculation, catalog) {
  const baseKey = calculatorBaseKey(calculation, catalog);
  const base = catalog.items[baseKey];
  if (!base || !base.price) throw new Error(`В Bitrix24 не задана цена услуги «${base?.name || baseKey}»`);
  const quantity = calculatorQuantity(calculation, baseKey);
  const incoming = baseKey !== 'live_in';
  const autoOneTime = baseKey === 'one_time' || (incoming && quantity === 1);
  const rows = [{ PRODUCT_ID: base.id, PRICE: base.price, QUANTITY: quantity, SORT: 1 }];

  if (autoOneTime || requestedCheckbox(calculation, 'oneTime')) addPercentageRow(rows, catalog, 'surcharge_one_time', quantity, base.price);
  if (incoming && !autoOneTime && quantity < 5) addPercentageRow(rows, catalog, 'surcharge_less_than_five', quantity, base.price);

  const weekend = Number(calculation?.weekendMode) || 0;
  if (incoming && weekend) addPercentageRow(rows, catalog, 'surcharge_weekend', quantity, base.price);
  const holiday = Number(calculation?.holidayMode) || 0;
  if (holiday === 30) addPercentageRow(rows, catalog, 'surcharge_holiday_30', quantity, base.price);
  if (holiday === 100) addPercentageRow(rows, catalog, 'surcharge_holiday_100', quantity, base.price);
  if (requestedCheckbox(calculation, 'experienced')) addPercentageRow(rows, catalog, 'surcharge_experienced', quantity, base.price);
  if (requestedCheckbox(calculation, 'twoPeople')) addPercentageRow(rows, catalog, 'surcharge_two_people', quantity, base.price);
  if (requestedCheckbox(calculation, 'complex')) addPercentageRow(rows, catalog, 'surcharge_complex', quantity, base.price);

  if (requestedCheckbox(calculation, 'pet')) {
    const product = catalog.items.surcharge_pet;
    rows.push({ PRODUCT_ID: product.id, PRICE: product.price, QUANTITY: quantity, SORT: rows.length + 1 });
  }
  if (requestedCheckbox(calculation, 'urgent')) {
    const product = catalog.items.surcharge_urgent;
    rows.push({ PRODUCT_ID: product.id, PRICE: product.price, QUANTITY: 1, SORT: rows.length + 1 });
  }
  return rows;
}

function buildCalculatorSnapshotRows(calculation) {
  const rows = Array.isArray(calculation?.productRows) ? calculation.productRows : [];
  return rows
    .map(row => {
      const name = cleanText(row?.name, 300);
      const quantity = numberOrZero(row?.quantity);
      const price = currencyNumber(row?.price);
      return name && quantity ? `• ${name}: ${quantity} × ${formatRubles(price)}` : '';
    })
    .filter(Boolean);
}

function buildSiteNote(lead) {
  const form = cleanText(lead.form, 100);
  const leadType = lead.leadType === 'recruitment' ? 'recruitment' : 'client';
  const lines = [];

  if (form === 'care_calculator' && lead.calculation && typeof lead.calculation === 'object') {
    const calculation = lead.calculation;
    lines.push('Запрос из калькулятора');
    if (cleanText(calculation.baseLabel, 200)) lines.push(`Услуга: ${cleanText(calculation.baseLabel, 200)}`);
    if (numberOrZero(calculation.quantity)) lines.push(`${cleanText(calculation.qtyLabel, 100) || 'Количество'}: ${numberOrZero(calculation.quantity)}`);
    if (cleanText(calculation.age, 50)) lines.push(`Возраст подопечного: ${cleanText(calculation.age, 50)}`);
    if (cleanText(calculation.gender, 100)) lines.push(`Пол подопечного: ${cleanText(calculation.gender, 100)}`);
    if (cleanText(calculation.bedridden, 200)) lines.push(`Состояние: ${cleanText(calculation.bedridden, 200)}`);
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

function formatRubles(value) {
  const amount = numberOrZero(value);
  return amount ? `${amount.toLocaleString('ru-RU')} ₽` : '';
}

function buildCalculatorDetails(lead) {
  if (lead?.form !== 'care_calculator' || !lead.calculation || typeof lead.calculation !== 'object') return '';

  const calculation = lead.calculation;
  const blocks = ['ИСХОДНЫЙ ЗАПРОС ИЗ КАЛЬКУЛЯТОРА'];
  const request = [];
  if (cleanText(calculation.baseLabel, 200)) request.push(`Услуга: ${cleanText(calculation.baseLabel, 200)}`);
  if (numberOrZero(calculation.quantity)) request.push(`${cleanText(calculation.qtyLabel, 100) || 'Количество'}: ${numberOrZero(calculation.quantity)}`);
  if (request.length) blocks.push(request.join('\n'));

  const items = buildCalculatorSnapshotRows(calculation);
  if (items.length) blocks.push(`ТОВАРЫ И НАДБАВКИ В ИСХОДНОМ ЗАПРОСЕ\n${items.join('\n')}`);

  const person = [];
  if (cleanText(calculation.age, 50)) person.push(`Возраст: ${cleanText(calculation.age, 50)}`);
  if (cleanText(calculation.gender, 100)) person.push(`Пол: ${cleanText(calculation.gender, 100)}`);
  if (cleanText(calculation.bedridden, 200)) person.push(`Состояние: ${cleanText(calculation.bedridden, 200)}`);
  if (person.length) blocks.push(`ДАННЫЕ ПОДОПЕЧНОГО\n${person.join('\n')}`);

  const situations = Array.isArray(lead.selectedSituations)
    ? lead.selectedSituations.map(item => cleanText(item, 300)).filter(Boolean)
    : [];
  if (situations.length) blocks.push(`СИТУАЦИЯ КЛИЕНТА\n${situations.map(item => `• ${item}`).join('\n')}`);

  const comment = cleanText(calculation.comment, 2000);
  if (comment) blocks.push(`КОММЕНТАРИЙ КЛИЕНТА\n${comment}`);

  return blocks.join('\n\n');
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function enrichCalculatorSnapshot(calculation, catalog, productRows) {
  const baseKey = calculatorBaseKey(calculation, catalog);
  const base = catalog.items[baseKey];
  const quantity = calculatorQuantity(calculation, baseKey);
  return {
    ...calculation,
    baseLabel: base.name,
    basePrice: base.price,
    quantity,
    productRows: productRows.map(row => {
      const product = Object.values(catalog.items).find(item => item.id === Number(row.PRODUCT_ID));
      return { name: product?.name || 'Товар из каталога', price: row.PRICE, quantity: row.QUANTITY };
    })
  };
}

async function createBitrixDeal(lead) {
  if (!bitrixWebhookUrl) throw new Error('Интеграция с Bitrix24 ещё не настроена на сервере');
  const leadType = lead.leadType === 'recruitment' ? 'recruitment' : 'client';
  const phone = normalizePhone(lead.phone);
  if (phone.replace(/\D/g, '').length < 10) throw new Error('Некорректный телефон');

  const name = cleanText(lead.name, 120) || 'Без имени';
  const assignedManagerId = leadType === 'client' ? await nextAssignedManager() : 0;
  const contactId = await bitrixCall('crm.contact.add', {
    fields: {
      NAME: name,
      TYPE_ID: leadType === 'recruitment' ? 'PARTNER' : 'CLIENT',
      PHONE: [{ VALUE: phone, VALUE_TYPE: 'WORK' }]
    }
  });
  let calculation = lead?.calculation;
  let productRows = null;
  if (lead.form === 'care_calculator' && calculation && typeof calculation === 'object') {
    const catalog = await getCalculatorCatalog(true);
    productRows = buildCalculatorProductRows(calculation, catalog);
    calculation = enrichCalculatorSnapshot(calculation, catalog, productRows);
  }
  const safeLead = calculation === lead?.calculation ? lead : { ...lead, calculation };
  const title = cleanText(lead?.bitrix?.title, 200) || (leadType === 'recruitment' ? 'Отклик сиделки с сайта' : 'Заявка на подбор ухода с сайта');
  const fields = { TITLE: `${title} — ${name}`, CONTACT_ID: contactId };
  if (assignedManagerId) fields.ASSIGNED_BY_ID = assignedManagerId;
  if (siteNoteField) fields[siteNoteField] = buildSiteNote(safeLead);
  const calculatorDetails = buildCalculatorDetails(safeLead);
  if (calculatorDetailsField && calculatorDetails) fields[calculatorDetailsField] = calculatorDetails;
  if (categories[leadType] !== '') fields.CATEGORY_ID = Number(categories[leadType]);
  const dealId = await bitrixCall('crm.deal.add', { fields });
  if (productRows?.length) await bitrixCall('crm.deal.productrows.set', { id: dealId, rows: productRows });
  return { dealId, assignedManagerId };
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
  // После обновления приложения Битрикс может оставить старую подписку
  // обработчика. Снимаем только нашу точную пару «событие + URL» и ставим
  // заново, не затрагивая обработчики других интеграций.
  try {
    await bitrixOpenLineCall('event.unbind', {
      event: 'OnImConnectorMessageAdd', handler: handlerUrl
    }, auth);
  } catch (error) {
    console.warn('Open line event unbind skipped:', error.message);
  }
  await bitrixOpenLineCall('event.bind', {
    event: 'OnImConnectorMessageAdd', handler: handlerUrl
  }, auth);

  // В Bitrix24 у портала уже настроены каналы (формы, мессенджеры) на одну
  // Открытую линию. Для чата сайта используем эту же первую линию: тогда он
  // попадает в ту же очередь менеджеров, а не создаёт отдельный маршрут.
  const store = await getBridgeStore();
  if (store.lineId) return;
  const result = await bitrixOpenLineCall('imopenlines.config.list.get', {
    PARAMS: {
      select: ['ID', 'ACTIVE'],
      order: { ID: 'asc' },
      limit: 1
    },
    OPTIONS: {}
  }, auth);
  const lines = Array.isArray(result) ? result : Object.values(result || {});
  const lineId = cleanText(lines[0]?.ID, 40);
  if (!lineId) throw new Error('В Bitrix24 не найдена Открытая линия для чата сайта');
  await activateOpenLine(lineId, 1, auth);
  store.lineId = lineId;
  await saveBridgeStore();
}

async function activateOpenLine(lineId, activeStatus, auth) {
  await bitrixOpenLineCall('imconnector.activate', {
    CONNECTOR: openLine.connectorId,
    LINE: Number(lineId),
    ACTIVE: Number(activeStatus ?? 1)
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
}

async function handleOpenLineHandler(payload, url) {
  const auth = getBitrixRequestAuth(payload, url);
  const store = await getBridgeStore();
  if (payload?.event) {
    const incomingMessages = indexedValues(payload?.data?.MESSAGES);
    console.info('Open line handler event:', {
      event: cleanText(payload.event, 100),
      connector: cleanText(payload?.data?.CONNECTOR, 100),
      messages: incomingMessages.length,
      chatIds: incomingMessages.map(message => cleanChatId(message?.chat?.id)).filter(Boolean)
    });
  }
  if (payload.event === 'ONIMCONNECTORMESSAGEADD' && payload?.data?.CONNECTOR === openLine.connectorId) {
    const lineId = cleanText(payload?.data?.LINE, 40) || store.lineId;
    for (const source of indexedValues(payload?.data?.MESSAGES)) {
      const chatId = cleanChatId(source?.chat?.id);
      const session = store.sessions[chatId];
      if (!session) continue;
      const text = cleanText(source?.message?.text, 12000);
      if (!text) continue;
      const externalMessageId = `operator_${randomBytes(12).toString('base64url')}`;
      session.managerMessages = Array.isArray(session.managerMessages) ? session.managerMessages : [];
      session.managerBitrixMessageIds = Array.isArray(session.managerBitrixMessageIds) ? session.managerBitrixMessageIds : [];
      const bitrixMessageId = cleanText(source?.im?.message_id, 100);
      if (bitrixMessageId) session.managerBitrixMessageIds.push(bitrixMessageId);
      session.managerBitrixMessageIds = Array.from(new Set(session.managerBitrixMessageIds.map(String))).slice(-300);
      session.managerMessages.push({ id: externalMessageId, text, timestamp: Date.now() });
      session.managerMessages = session.managerMessages.slice(-100);
      session.updatedAt = Date.now();
      // Сначала сохраняем текст для виджета сайта. Подтверждение Bitrix24 —
      // служебная операция; его временная ошибка не должна лишать клиента
      // ответа менеджера.
      await saveBridgeStore();
      try {
        await bitrixOpenLineCall('imconnector.send.status.delivery', {
          CONNECTOR: openLine.connectorId,
          LINE: Number(lineId),
          MESSAGES: [{
            im: { chat_id: Number(source?.im?.chat_id), message_id: Number(source?.im?.message_id) },
            message: { id: [externalMessageId], date: Math.floor(Date.now() / 1000) },
            chat: { id: chatId }
          }]
        }, auth);
      } catch (error) {
        console.warn('Open line delivery acknowledgement failed:', error.message);
      }
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
    await activateOpenLine(lineId, options?.ACTIVE_STATUS, auth);
    store.lineId = lineId;
    await saveBridgeStore();
  }
}

createServer(async (request, response) => {
  const url = new URL(request.url || '/', 'http://localhost');
  if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });

  // Локальное приложение Bitrix24 передаёт контекст в POST-запросе к iframe.
  // Поэтому эти две страницы отдаём и на GET, и на POST, хотя остальные
  // статические файлы сайта доступны только для чтения.
  const bitrixParticipantPages = {
    '/api/bitrix/participants/install': 'bitrix-participants-install.html',
    '/api/bitrix/participants/widget': 'bitrix-participants.html',
    // Separate local Bitrix24 app for the shift checklist. It deliberately
    // uses a different placement and does not change the deal participants
    // application above.
    '/api/bitrix/shift-checklist/install': 'bitrix-shift-checklist-install.html',
    '/api/bitrix/shift-checklist/widget': 'bitrix-shift-checklist.html'
  };
  if ((request.method === 'GET' || request.method === 'POST') && bitrixParticipantPages[url.pathname]) {
    const pagePath = join(siteRoot, bitrixParticipantPages[url.pathname]);
    const stat = await fs.stat(pagePath);
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    return createReadStream(pagePath).pipe(response);
  }

  // Публичный калькулятор не хранит вебхук: он получает только разрешённые
  // позиции и цены через этот серверный прокси. Так Bitrix24 остаётся
  // единственным источником цен, а секрет интеграции не попадает на сайт.
  if (request.method === 'GET' && url.pathname === '/api/calculator/catalog') {
    try {
      return json(response, 200, { ok: true, catalog: await getCalculatorCatalog() });
    } catch (error) {
      console.error('Calculator catalog read failed:', error.message);
      return json(response, 503, { ok: false, error: 'Каталог калькулятора временно недоступен' });
    }
  }

  const calculatorImageMatch = url.pathname.match(/^\/api\/calculator\/catalog\/image\/(\d+)$/);
  if (request.method === 'GET' && calculatorImageMatch) {
    try {
      const image = await getCalculatorProductImage(Number(calculatorImageMatch[1]));
      if (!image) return json(response, 404, { ok: false, error: 'У товара нет картинки' });
      response.writeHead(200, {
        'Content-Type': image.contentType,
        'Content-Length': image.body.length,
        'Cache-Control': 'public, max-age=300'
      });
      return response.end(image.body);
    } catch (error) {
      console.error('Calculator product image read failed:', error.message);
      return json(response, 404, { ok: false, error: 'Картинка товара временно недоступна' });
    }
  }

  if (request.method === 'POST' && url.pathname === '/api/leads') {
    try {
      const lead = await readJson(request);
      const result = await createBitrixDeal(lead);
      return json(response, 201, { ok: true, ...result });
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
      // При открытии настроек коннектора Bitrix24 передаёт параметры линии в
      // query string, а не в теле запроса. Объединяем оба варианта.
      const payload = request.method === 'POST'
        ? await readBody(request)
        : Object.fromEntries(url.searchParams.entries());
      if (url.searchParams.get('token') !== openLine.callbackToken) {
        console.warn('Open line handler rejected request:', {
          event: cleanText(payload?.event, 100),
          connector: cleanText(payload?.data?.CONNECTOR, 100),
          hasToken: Boolean(url.searchParams.get('token'))
        });
        throw new Error('Недействительный токен обработчика');
      }
      await handleOpenLineHandler(payload, url);
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
      console.error('Manager handoff failed:', error.message);
      return json(response, 503, { ok: false, code: 'UNAVAILABLE' });
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
    await syncManagerMessages(chatId);
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
}).listen(port, async () => {
  console.log(`Site listening on :${port}`);

  // Возврат сделок после отпуска не зависит от того, открывал ли менеджер
  // карточку. Проверяем истёкшие замещения после старта и далее каждый час.
  restoreExpiredSubstitutions().catch(error => console.error('Substitution restore failed:', error.message));
  const substitutionTimer = setInterval(() => {
    restoreExpiredSubstitutions().catch(error => console.error('Substitution restore failed:', error.message));
  }, 60 * 60 * 1000);
  substitutionTimer.unref();

  // Подписку на ответ менеджера нужно восстанавливать и после обычного
  // перезапуска сайта: данные авторизации приложения сохранены в volume,
  // а Bitrix24 не всегда повторно вызывает обработчик установки сам.
  if (!isOpenLineConfigured()) return;
  try {
    const store = await getBridgeStore();
    if (!store.auth) return;
    await registerOpenLineConnector(store.auth);
    console.info('Open Line connector and reply event rebound on startup');
  } catch (error) {
    console.error('Open Line startup rebind failed:', error.message);
  }
});
