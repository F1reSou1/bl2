export function parseIdList(value) {
  const ids = String(value || '')
    .split(/[\s,;]+/)
    .map(item => Number(item))
    .filter(id => Number.isInteger(id) && id > 0);
  return [...new Set(ids)];
}

export function chooseNextManager(configuredIds, activeIds, unavailableIds, lastManagerId = 0) {
  const active = new Set((activeIds || []).map(Number));
  const unavailable = new Set((unavailableIds || []).map(Number));
  const queue = (configuredIds || [])
    .map(Number)
    .filter(id => Number.isInteger(id) && id > 0 && active.has(id) && !unavailable.has(id));
  if (!queue.length) return 0;
  const previousIndex = queue.indexOf(Number(lastManagerId));
  return queue[(previousIndex + 1) % queue.length];
}

export function isSubstitutionActive(until, now = new Date()) {
  if (!until) return false;
  const value = /^\d{4}-\d{2}-\d{2}$/.test(String(until))
    ? new Date(`${until}T23:59:59.999+10:00`)
    : new Date(until);
  return Number.isFinite(value.getTime()) && value.getTime() >= now.getTime();
}

export function careRequestLabel(lead) {
  const calculation = lead?.calculation;
  if (calculation && typeof calculation === 'object') {
    return String(calculation.baseLabel || calculation.plan || '').trim() || 'Тип ухода уточняется';
  }
  return 'Тип ухода уточняется';
}

export function buildBookingWaitlistNote({ dealId, title, lead }) {
  const lines = [
    `Сделка #${Number(dealId) || 0}: ${String(title || '').trim() || 'Новая заявка на уход'}`,
    `Услуга: ${careRequestLabel(lead)}`,
    'Подопечный: назначается во вкладке «Участники сделки»',
    'Сиделка и график: требуется назначение менеджером'
  ];
  return lines.join('\n').slice(0, 4000);
}
