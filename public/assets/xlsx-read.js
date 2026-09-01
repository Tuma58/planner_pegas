// Чтение .xlsx в браузере без библиотек: xlsx — это ZIP с XML внутри.
// ZIP разбираем по central directory, потоки распаковываем нативным
// DecompressionStream('deflate-raw'), из XML берём sharedStrings и первый
// лист. Покрывает выгрузки 1С (простые листы без формул и стилей).
// Возвращает массив строк-массивов значений.

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream()
    .pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Разбор ZIP: идём по central directory (сигнатура PK\x01\x02), для каждого
// файла достаём смещение локального заголовка и вырезаем сжатые данные.
async function unzip(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const files = {};
  // End of central directory: ищем сигнатуру с конца.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Не похоже на xlsx: нет оглавления ZIP');
  let offset = view.getUint32(eocd + 16, true);
  const count = view.getUint16(eocd + 10, true);
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) break;
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 46, offset + 46 + nameLen));
    // Локальный заголовок: свои длины имени/extra.
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    files[name] = { method, data: bytes.subarray(dataStart, dataStart + compSize) };
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

async function readEntry(files, name) {
  const entry = files[name];
  if (!entry) return null;
  const raw = entry.method === 0 ? entry.data : await inflateRaw(entry.data);
  return new TextDecoder().decode(raw);
}

const unescapeXml = value => value
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/g, '&');

const colIndex = ref => {
  let n = 0;
  for (const ch of ref) {
    if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64);
    else break;
  }
  return n - 1;
};

// Excel хранит даты числами (дней с 1900 года) — переводим в ISO.
export const excelDate = value => {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 20000 || n > 60000) return null;
  const ms = Math.round((n - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
};

export async function readXlsx(file) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Браузер не поддерживает чтение xlsx — обновите браузер');
  }
  const files = await unzip(await file.arrayBuffer());
  const sharedXml = await readEntry(files, 'xl/sharedStrings.xml');
  const shared = [];
  if (sharedXml) {
    for (const m of sharedXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      const texts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(t => unescapeXml(t[1]));
      shared.push(texts.join(''));
    }
  }
  // Первый лист: ищем sheet1, иначе любой sheet*.xml.
  const sheetName = files['xl/worksheets/sheet1.xml'] ? 'xl/worksheets/sheet1.xml'
    : Object.keys(files).find(name => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
  const sheetXml = await readEntry(files, sheetName);
  if (!sheetXml) throw new Error('В xlsx не найден лист с данными');
  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cell of rowMatch[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>/g)) {
      const idx = colIndex(cell[1]);
      const attrs = cell[2];
      const body = cell[3];
      let value = '';
      const v = body.match(/<v>([\s\S]*?)<\/v>/);
      const inline = body.match(/<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/);
      if (inline) value = unescapeXml(inline[1]);
      else if (v) {
        value = unescapeXml(v[1]);
        if (/t="s"/.test(attrs)) value = shared[Number(value)] ?? value;
      }
      row[idx] = value;
    }
    rows.push(row);
  }
  return rows;
}
