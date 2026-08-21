import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildBookingWaitlistNote,
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

test('waitlist note contains deal, service and remaining manager action', () => {
  const note = buildBookingWaitlistNote({
    dealId: 52,
    title: 'Расчёт ухода с сайта — Ксения',
    lead: { calculation: { baseLabel: 'Почасовой уход — 4 часа' } }
  });
  assert.match(note, /Сделка #52/);
  assert.match(note, /Почасовой уход/);
  assert.match(note, /Сиделка и график/);
});

test('server and deal widget contain required integration calls', async () => {
  const [server, widget] = await Promise.all([
    readFile(new URL('../server.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../bitrix-participants.html', import.meta.url), 'utf8')
  ]);
  for (const method of ['booking.v1.waitlist.add', 'booking.v1.waitlist.externalData.set', 'ASSIGNED_BY_ID']) {
    assert.ok(server.includes(method), `server must use ${method}`);
  }
  for (const method of ['crm.timeline.comment.add', 'booking.v1.resource.add', 'booking.v1.waitlist.client.set']) {
    assert.ok(widget.includes(method), `widget must use ${method}`);
  }
  assert.match(widget, /Передать клиента/);
});
