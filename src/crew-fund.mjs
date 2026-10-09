// Водопад фонда экипажа — раскладка времени рейса на работу и потери.
// Определение руководителя (09.10): в 67% потолка — ВСЯ работа водителя
// (вождение, погрузки/выгрузки, перегоны), 33% — только отдых. Работа
// считается нормативами: дорога = км рейса / живая Vтех (CAN), каждая
// операция на воротах (включая первую погрузку и финальную выгрузку) =
// живой норматив ворот из транзита; всё фактическое время сверх
// закладок — потери своего куска (отдых в пути, погрузка/выгрузка
// сверх норматива). Никаких зашитых констант: Vтех и ворота — живые.
//
// Рейс делится на три куска по отметкам:
//   A [на линию → убытие с погрузки]  — подгон + первая погрузка
//   B [убытие → прибытие на выгрузку] — под грузом (дорога + пром. ворота)
//   C [прибытие → выгрузка]           — финальная выгрузка
// Работа куска клампится его фактической длиной (быстрее закладки —
// засчитан факт), вклад в период — долей пересечения куска с периодом.

const parseTs = v => Date.parse(String(v).replace(' ', 'T'));

// trip: { online, dep, arrived, fin, km, stopsN, cutMs? }
//   cutMs — обрезка хвоста при стыковке внахлёст (старт следующего
//   рейса машины раньше отметки выгрузки: машина не живёт дважды).
// opts: { vtech, gateNormH, fromMs, toMs }
export function tripFundBreakdown(trip, opts) {
  const { vtech, gateNormH, fromMs, toMs } = opts;
  const zero = { work: 0, restRoad: 0, loadOver: 0, unloadOver: 0 };
  const onlineMs = parseTs(trip.online);
  let finMs = parseTs(trip.fin);
  if (Number.isFinite(trip.cutMs)) finMs = Math.min(finMs, trip.cutMs);
  if (!Number.isFinite(onlineMs) || !(finMs > onlineMs)) return zero;
  // Куски: без отметки убытия весь рейс — «подгон+погрузка» (A);
  // прибытие на выгрузку без убытия невозможно по смыслу — клампы
  // держат порядок точек даже на кривых данных.
  const depMs = trip.dep
    ? Math.min(Math.max(parseTs(trip.dep), onlineMs), finMs) : finMs;
  const arrMs = trip.arrived && trip.dep
    ? Math.min(Math.max(parseTs(trip.arrived), depMs), finMs) : finMs;
  const hours = (s, e) => (e - s) / 3.6e6;
  const aH = hours(onlineMs, depMs);
  const bH = hours(depMs, arrMs);
  const cH = hours(arrMs, finMs);
  const workA = Math.min(aH, gateNormH);
  const midGates = Math.max(0, (trip.stopsN || 0) - 2) * gateNormH;
  const workB = Math.min(bH, Number(trip.km || 0) / vtech + midGates);
  const workC = Math.min(cH, gateNormH);
  // Вклад куска в период отчёта — долей пересечения.
  const part = (s, e, value) => {
    if (!(e > s) || value <= 0) return 0;
    const cs = Math.max(s, fromMs);
    const ce = Math.min(e, toMs);
    return ce > cs ? value * (ce - cs) / (e - s) : 0;
  };
  return {
    work: part(onlineMs, depMs, workA) + part(depMs, arrMs, workB)
      + part(arrMs, finMs, workC),
    restRoad: part(depMs, arrMs, bH - workB),
    loadOver: part(onlineMs, depMs, aH - workA),
    unloadOver: part(arrMs, finMs, cH - workC)
  };
}

// Обрезка стыковок внахлёст: рейсы одной машины по порядку выхода,
// хвост каждого не длиннее старта следующего. Мутирует cutMs.
export function markOverlapCuts(trips) {
  const byVeh = new Map();
  for (const t of trips) {
    if (!byVeh.has(t.vehicleId)) byVeh.set(t.vehicleId, []);
    byVeh.get(t.vehicleId).push(t);
  }
  for (const list of byVeh.values()) {
    list.sort((x, y) => parseTs(x.online) - parseTs(y.online));
    for (let i = 0; i + 1 < list.length; i += 1) {
      const nextStart = parseTs(list[i + 1].online);
      const fin = parseTs(list[i].fin);
      if (Number.isFinite(nextStart) && Number.isFinite(fin) && nextStart < fin) {
        list[i].cutMs = nextStart;
      }
    }
  }
  return trips;
}

// Пересечение двух списков отрезков [startMs, endMs] в часах — union
// внутри каждого списка, чтобы дубли диспозиций не двоили. Нужен фонду:
// рейс поверх закрытой «недоступности» возвращает это время в фонд
// (истина — конструкция: рейс документирован отметками).
export function intervalOverlapH(listA, listB) {
  const norm = list => {
    const sorted = [...list].filter(x => x && x[1] > x[0])
      .sort((x, y) => x[0] - y[0]);
    const out = [];
    for (const [s, e] of sorted) {
      if (out.length && s <= out[out.length - 1][1]) {
        out[out.length - 1][1] = Math.max(out[out.length - 1][1], e);
      } else out.push([s, e]);
    }
    return out;
  };
  const A = norm(listA), B = norm(listB);
  let i = 0, j = 0, total = 0;
  while (i < A.length && j < B.length) {
    const s = Math.max(A[i][0], B[j][0]);
    const e = Math.min(A[i][1], B[j][1]);
    if (e > s) total += e - s;
    if (A[i][1] < B[j][1]) i += 1; else j += 1;
  }
  return total / 3.6e6;
}
