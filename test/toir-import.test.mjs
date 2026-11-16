// История ТОиР из 1С (14.11.2026): идемпотентный апсерт заявок, работ и
// ремонтных листов; серийные даты 1С — московские.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../src/db.mjs';
import { importRepairRequests, importRepairSheets, serialToIso, toirHistoryBoard } from '../src/toir-import.mjs';

function freshDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pegas-toir-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const db = openDatabase(path.join(directory, 'planner.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
}

test('серийная дата 1С — московская: 46235.5 = 01.08.2026 12:00 МСК', () => {
  assert.equal(serialToIso(46235.5), '2026-08-01T09:00:00.000Z');
  assert.equal(serialToIso('2026-08-01'), '2026-08-01T00:00:00.000Z');
  assert.equal(serialToIso(''), null);
});

test('импорт ТОиР: апсерт по номерам, прицепы — только в РЛ, сводка истории', t => {
  const db = freshDb(t);
  const vehicle = db.prepare(`SELECT id, plate FROM vehicles LIMIT 1`).get();
  const requests = [
    { externalNo: 'ПА000023189', createdAt: 46235.3, plate: ` ${vehicle.plate.toUpperCase()} `,
      purpose: 'плановый ремонт', status: 'released', status1c: 'Выполнен',
      complaint: 'Не запускается реф', defects: 'Не запускается реф', recommendations: '',
      odometerKm: 27716, arrivedAt: 46235.32, workStartedAt: 46235.37, finishedAt: 46235.41, releasedAt: 46235.46 },
    { externalNo: 'ПА000023190', createdAt: 46236.1, plate: 'зз9999 99', purpose: 'ТО',
      status: 'released', status1c: 'Выполнен' } // прицепа нет в парке
  ];
  const works = [
    { externalNo: 'ПА000023189', line: 1, title: 'Диагностика рефа', confirmed: 'да' },
    { externalNo: 'ПА000023189', line: 2, title: 'Замена датчика', confirmed: '' },
    { externalNo: 'ПА000023190', line: 1, title: 'не попадёт — заявка пропущена' }
  ];
  const first = importRepairRequests(db, requests, works, '2026-11-14T10:00:00.000Z');
  assert.deepEqual([first.added, first.updated, first.jobs, first.skipped.length], [1, 0, 2, 1]);
  const order = db.prepare(`SELECT * FROM repair_orders WHERE external_no='ПА000023189'`).get();
  assert.equal(order.vehicle_id, vehicle.id);
  assert.equal(order.status, 'released');
  assert.ok(order.arrived_at < order.released_at);
  // Повтор: обновление, работы не дублируются (детерминированный id).
  const second = importRepairRequests(db, requests, works, '2026-11-15T10:00:00.000Z');
  assert.deepEqual([second.added, second.updated], [0, 1]);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM repair_jobs WHERE order_id=?`).get(order.id).n, 2);
  // Ремонтные листы: прицеп ложится с пустым vehicle_id, деньги целы.
  const sheets = [
    { externalNo: 'АР00082963 ', month: '2026-08', plate: 'зз9999 99', vehicleKind: 'прицеп',
      kind: 'Кузовной ремонт', groupKind: 'Ремонт', status: 'Выполнен', startedAt: 46235.33,
      finishedAt: 46235.39, hours: 1.5, worksRub: 1000, partsStockRub: 500, totalRub: 1500 },
    { externalNo: 'ПА000013331', month: '2026-09', plate: vehicle.plate, vehicleKind: 'тягач',
      kind: 'ТО', groupKind: 'ТО', status: 'Выполнен', totalRub: 9000 }
  ];
  assert.equal(importRepairSheets(db, sheets).count, 2);
  assert.equal(importRepairSheets(db, sheets).count, 2); // идемпотентно
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM repair_sheets`).get().n, 2);
  const trailer = db.prepare(`SELECT * FROM repair_sheets WHERE external_no='АР00082963'`).get();
  assert.equal(trailer.vehicle_id, null);
  assert.equal(trailer.total_rub, 1500);
  const board = toirHistoryBoard(db);
  assert.equal(board.totals.n, 2);
  assert.equal(board.totals.rub, 10500);
  assert.ok(board.months.some(month => month.month === '2026-09'
    && month.groups.some(group => group.group === 'ТО' && group.rub === 9000)));
  assert.equal(board.topVehicles[0].plate, vehicle.plate);
});
