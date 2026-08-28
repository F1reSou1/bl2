import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  chooseNextManager,
  isSubstitutionActive,
  parseIdList
} from '../crm-automation.mjs';

test('manager id configuration is normalized and deduplicated', () => {
  assert.deepEqual(parseIdList('12, 16;18 16 bad -2'), [12, 16, 18]);
});

test('round robin rotates in configured order', () => {
  const configured = [12, 16, 18];
  assert.equal(chooseNextManager(configured, configured, [], 0), 12);
  assert.equal(chooseNextManager(configured, configured, [], 12), 16);
  assert.equal(chooseNextManager(configured, configured, [], 18), 12);
});

test('round robin skips inactive and vacation managers', () => {
  assert.equal(chooseNextManager([12, 16, 18], [12, 16, 18], [16], 12), 18);
  assert.equal(chooseNextManager([12, 16, 18], [12, 16], [12, 16], 12), 0);
});

test('substitution remains active through the selected end date', () => {
  assert.equal(isSubstitutionActive('2026-08-21', new Date('2026-08-21T12:00:00')), true);
  assert.equal(isSubstitutionActive('2026-08-20', new Date('2026-08-21T00:00:00')), false);
});

test('server and deal widget contain required integration calls', async () => {
  const [server, widget] = await Promise.all([
    readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../bitrix-participants.html', import.meta.url), 'utf8')
  ]);
  for (const method of ['ASSIGNED_BY_ID', 'COMMENTS', 'sitters.blizkie-vl.ru/deals/${dealId}']) {
    assert.ok(server.includes(method), `server must use ${method}`);
  }
  assert.match(server, /ensureNewDealLinks/);
  assert.match(server, /ensureNewShiftBookingLinks/);
  assert.match(server, /booking\.v1\.booking\.list/);
  assert.match(server, /CATEGORY_ID: 2, STAGE_ID: 'C2:NEW'/);
  for (const method of ['crm.timeline.comment.add', 'booking.v1.resource.add', 'booking.v1.resource.update', 'booking.v1.resource.slots.set', 'booking.v1.booking.add', 'booking.v1.booking.list', 'booking.v1.booking.client.set', 'booking.v1.booking.externalData.set']) {
    assert.ok(widget.includes(method), `widget must use ${method}`);
  }
  assert.doesNotMatch(server, /booking\.v1\.waitlist\./);
  assert.doesNotMatch(widget, /booking\.v1\.waitlist\./);
  assert.match(widget, /Передать клиента/);
  assert.match(widget, /from: 0/);
  assert.match(widget, /to: 1440/);
  assert.match(widget, /Asia\/Vladivostok/);
  assert.match(widget, /findCaregiverType/);
  assert.match(widget, /findResourceByName/);
  assert.match(widget, /\$\{caregiverName\} - \$\{contactNumber\}/);
  assert.match(widget, /padStart\(4, '0'\)/);
  assert.match(widget, /contactMarker/);
  assert.match(widget, /resourceWasCreated/);
  assert.match(widget, /resourceNeedsUpdate/);
  assert.match(widget, /retryFind/);
  assert.match(widget, /canonicalName/);
  assert.match(widget, /resourceType/);
  assert.match(widget, /itemName/);
  assert.match(widget, /itemId/);
  assert.match(widget, /searchQuery: 'Сиделка'/);
  assert.match(widget, /filter: \{ searchQuery: contactNumber \}/);
  assert.match(widget, /filter: \{ name: 'Сиделка' \}/);
  assert.match(widget, /isMain: 'Y'/);
  assert.match(widget, /Открыть Онлайн-запись/);
  assert.match(widget, /UF_CRM_1787843951/);
  assert.match(widget, /UF_CRM_1787823737/);
  assert.match(widget, /UF_CRM_CARE_BOOKING_ID/);
  assert.match(widget, /loadShiftLinks/);
  assert.match(widget, /Управление чек-листом/);
  assert.match(widget, /Ручное проставление смены/);
  assert.match(widget, /sitters\.blizkie-vl\.ru\/checklist/);
  assert.match(widget, /deals\/\$\{dealId\}\/manual-shift/);
  assert.match(widget, /К участникам сделки/);
  assert.match(widget, /Создать запись/);
  assert.match(widget, /Расписание/);
  assert.match(widget, /Ближайшие 60 дней/);
  assert.match(widget, /refreshSchedule/);
  assert.match(widget, /Связанные смены отмечены под соответствующими записями/);
  assert.match(widget, /filter: \{ name \}/);
  assert.match(widget, /Ошибка: каталог ресурсов недоступен\./);
  assert.match(widget, /Готово: контакт назначен\./);
});
