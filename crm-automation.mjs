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

export function isShiftBookingTimeMatch({
  shiftStart,
  shiftEnd,
  bookingStart,
  bookingEnd,
  toleranceSeconds = 5 * 60
}) {
  const start = Number(shiftStart) || 0;
  const end = Number(shiftEnd) || start;
  const scheduledStart = Number(bookingStart) || 0;
  const scheduledEnd = Number(bookingEnd) || 0;
  if (!start || !scheduledStart) return false;

  // At the moment the caregiver starts a shift its real end is unknown.
  // A short 15-second test shift must therefore be linkable by its start.
  if (Math.abs(start - scheduledStart) <= toleranceSeconds) return true;
  if (scheduledEnd && start >= scheduledStart - toleranceSeconds && start <= scheduledEnd + toleranceSeconds) return true;

  return Boolean(
    end && scheduledEnd &&
    Math.abs(start - scheduledStart) <= toleranceSeconds &&
    Math.abs(end - scheduledEnd) <= toleranceSeconds
  );
}
