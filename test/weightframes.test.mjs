// Рамки весогабаритного контроля: разбор мест постановлений, слияние
// написаний, пересборка справочника из штрафов, коридор маршрута.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db.mjs';
import { upsertGibddFines } from '../src/gibdd.mjs';
import { framesNearLeg, frameKey, parseFrameLocation, pointToLegKm,
  rebuildWeightFrames, roadEndpoints } from '../src/weightframes.mjs';

const freshDb = t => {
  const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'wf-')), 'test.db'), {
    username: 'root-admin', password: 'Temporary-password-2026', fullName: 'Администратор'
  });
  t.after(() => db.close());
  return db;
};

test('разбор мест постановлений: все живые форматы ЛК', () => {
  const a = parseFrameLocation('18 км 790 м а/д Лапотково - Ефремов, Тульская область');
  assert.deepEqual(a, { road: 'Лапотково - Ефремов', km: 18.79, region: 'Тульская область' });
  const b = parseFrameLocation('А/Д ЛАПОТКОВО-ЕФРЕМОВ, КМ 18+790, ТУЛЬСКАЯ ОБЛ.');
  assert.equal(b.km, 18.79);
  assert.equal(frameKey(a), frameKey(b)); // написания сливаются в одну рамку
  const v = parseFrameLocation("АВТОМОБИЛЬНАЯ ДОРОГА 'ОБХОД Г. ВОРОНЕЖА' 4 КМ + 730 М, РАМОНСКИЙ Р-Н, ВОРОНЕЖСКАЯ ОБЛ.");
  assert.equal(v.km, 4.73);
  assert.match(v.road, /ОБХОД Г\. ВОРОНЕЖА/);
  assert.equal(v.region, 'ВОРОНЕЖСКАЯ ОБЛ.');
  // Код учёта дороги отбрасывается, топонимы остаются.
  const k = parseFrameLocation('41 км 270 м а/д 04 ОП РЗ 04K-044 Красноярск - Енисейск, Красноярский край');
  assert.equal(k.road.includes('ОП РЗ'), false);
  assert.deepEqual(roadEndpoints(k.road), ['Красноярск', 'Енисейск']);
  // Многозвенная дорога: концы — первый и последний топонимы.
  const r = parseFrameLocation("20 км 177 м а/д 'Рязань - Ряжск - Александро-Невский - Данков - Ефремов', Рязанская область");
  assert.deepEqual(roadEndpoints(r.road), ['Рязань', 'Ефремов']);
  assert.equal(parseFrameLocation('ПАРКОВКА №4092 МОСКВА'), null); // не рамка
});

test('справочник пересобирается из штрафов и копит счётчики', t => {
  const db = freshDb(t);
  const base = {
    gis_id: 1, auto_cdi: '58ХХ000111', in_processing: '0', bill_date: '2026-04-20',
    pay_due: '2026-07-01', amount: 600000, discount_pct: 0, discount_until: null,
    amount_discount: null, offense_time: '10:00', offense_at: '2026-04-10T07:00:00.000Z',
    article: '', status: 'nopayed'
  };
  upsertGibddFines(db, [
    { ...base, bill_id: 'УИН-Р1', article_number: 'ст.12.21.1 ч.6', offense_on: '2026-04-10',
      location: '18 км 790 м а/д Лапотково - Ефремов, Тульская область' },
    { ...base, bill_id: 'УИН-Р2', article_number: 'ст.12.21.1 ч.3', amount: 525000, offense_on: '2026-04-12',
      location: 'А/Д ЛАПОТКОВО-ЕФРЕМОВ, КМ 18+790, ТУЛЬСКАЯ ОБЛ.' },
    { ...base, bill_id: 'УИН-Р3', article_number: 'ст.12.21.1 ч.2', amount: 300000, offense_on: '2026-05-01',
      location: '87 км 500 м а/д Шадринск -Ялуторовск, Курганская область' },
    { ...base, bill_id: 'УИН-НЕ', article_number: '12.09.2 - Превышение скорости', amount: 500, offense_on: '2026-05-02',
      location: 'г. Пенза' } // не весогабарит — в справочник не попадает
  ]);
  const first = rebuildWeightFrames(db, randomUUID);
  assert.equal(first.frames, 2); // два места: написания Лапотково слились
  assert.equal(first.added, 2);
  const frame = db.prepare(`SELECT * FROM weight_frames WHERE road LIKE '%апотково%'`).get();
  assert.equal(frame.fines_count, 2);
  assert.equal(frame.fines_amount, 1125000);
  assert.equal(frame.last_offense_on, '2026-04-12');
  // Координаты и enabled пересборка не трогает.
  db.prepare(`UPDATE weight_frames SET latitude=53.6, longitude=37.6, geo_status='ok' WHERE id=?`)
    .run(frame.id);
  upsertGibddFines(db, [{ ...base, bill_id: 'УИН-Р4', article_number: 'ст.12.21.1 ч.6',
    offense_on: '2026-06-01', location: '88 км 490 м а/д Лапотково - Ефремов, Тульская область' }]);
  const second = rebuildWeightFrames(db, randomUUID);
  assert.equal(second.added, 1); // 88-й км — новая рамка
  const kept = db.prepare(`SELECT latitude, fines_count FROM weight_frames WHERE id=?`).get(frame.id);
  assert.equal(kept.latitude, 53.6);
  assert.equal(kept.fines_count, 2);
  // Сид настройки коридора: только вместо пустоты.
  const calc = JSON.parse(db.prepare(`SELECT value_json FROM settings WHERE key='calculation'`).get().value_json);
  assert.equal(calc.frameCorridorKm, 15);
});

test('коридор маршрута: рамка на пути ловится, в стороне — нет', t => {
  const db = freshDb(t);
  db.prepare(`INSERT INTO weight_frames(id, frame_key, road, km, latitude, longitude, fines_count, fines_amount)
    VALUES('f1','лапотковоефремов|19','Лапотково - Ефремов',18.79,53.58,37.55,12,6975000),
          ('f2','красноярскенисейск|41','Красноярск - Енисейск',41.27,56.3,93.0,5,1900000),
          ('f3','безкоординат|1','Без координат',1,NULL,NULL,1,100)`).run();
  // Москва → Ефремов: тульская рамка у трассы — в коридоре 40 км.
  const moscow = { latitude: 55.754, longitude: 37.62 };
  const efremov = { latitude: 53.146, longitude: 38.092 };
  const near = framesNearLeg(db, moscow, efremov, 40);
  assert.deepEqual(near.map(frame => frame.id), ['f1']); // Красноярск — за тысячи км
  assert.ok(near[0].awayKm < 40);
  assert.equal(framesNearLeg(db, moscow, efremov, 5).length, 0); // узкий коридор — мимо
  assert.equal(framesNearLeg(db, moscow, efremov, 0).length, 0); // 0 = выключено
  // Точка на самом отрезке — расстояние ~0.
  const mid = { latitude: (moscow.latitude + efremov.latitude) / 2,
    longitude: (moscow.longitude + efremov.longitude) / 2 };
  assert.ok(pointToLegKm(mid, moscow, efremov) < 1);
});
