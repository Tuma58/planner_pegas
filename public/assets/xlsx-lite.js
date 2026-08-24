// Чтение xlsx в браузере без библиотек (на сервере нет npm, поэтому весь
// разбор — на клиенте). Файл xlsx — это zip-архив: распаковка штатным
// DecompressionStream('deflate-raw'), листы и общие строки — XML через
// DOMParser. Возможностей ровно под выгрузки 1С «Заказы для отчёта»:
// первый лист книги, типы ячеек s / str / inlineStr / число.

// ── zip: каталог в конце файла → записи по смещениям ──
function findEocd(view) {
  // Сигнатура End of Central Directory ищется с конца (комментарий ≤ 64К).
  const min = Math.max(0, view.byteLength - 65_558);
  for (let i = view.byteLength - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) return i;
  }
  throw new Error('Файл не похож на xlsx (нет каталога zip)');
}

async function inflate(bytes, method) {
  if (method === 0) return bytes; // stored — без сжатия
  if (method !== 8) throw new Error(`Неподдерживаемое сжатие zip (метод ${method})`);
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Все записи архива: имя → {offset, method, compressedSize}; данные — лениво.
function zipEntries(buffer) {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const eocd = findEocd(view);
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i += 1) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const compressedSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const offset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, { offset, method, compressedSize });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = async name => {
    const entry = entries.get(name);
    if (!entry) return null;
    // Локальный заголовок: свои длины имени и extra перед данными.
    const lp = entry.offset;
    if (view.getUint32(lp, true) !== 0x04034b50) throw new Error('Повреждён zip (локальный заголовок)');
    const nameLen = view.getUint16(lp + 26, true);
    const extraLen = view.getUint16(lp + 28, true);
    const start = lp + 30 + nameLen + extraLen;
    return inflate(bytes.subarray(start, start + entry.compressedSize), entry.method);
  };
  return { names: [...entries.keys()], read };
}

const xml = text => new DOMParser().parseFromString(text, 'application/xml');
const decode = bytes => new TextDecoder().decode(bytes);

// Колонка "AB" из адреса ячейки "AB12" → индекс с нуля.
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    if (ch < 'A' || ch > 'Z') break;
    n = n * 26 + (ch.charCodeAt(0) - 64);
  }
  return n - 1;
}

// Первый лист книги → строки-массивы значений (строка или число).
export async function readXlsxRows(file) {
  const zip = zipEntries(await file.arrayBuffer());
  // Первый лист по порядку в workbook.xml → его файл через rels.
  const workbook = xml(decode(await zip.read('xl/workbook.xml')));
  const sheet = workbook.querySelector('sheet');
  if (!sheet) throw new Error('В книге нет листов');
  const relId = sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
  const rels = xml(decode(await zip.read('xl/_rels/workbook.xml.rels')));
  let target = [...rels.querySelectorAll('Relationship')]
    .find(rel => rel.getAttribute('Id') === relId)?.getAttribute('Target') || 'worksheets/sheet1.xml';
  if (target.startsWith('/')) target = target.slice(1);
  else if (!target.startsWith('xl/')) target = `xl/${target}`;
  // Общие строки (может не быть, если все значения числовые).
  const sharedBytes = await zip.read('xl/sharedStrings.xml');
  const shared = sharedBytes
    ? [...xml(decode(sharedBytes)).querySelectorAll('si')]
      .map(si => [...si.querySelectorAll('t')].map(t => t.textContent).join(''))
    : [];
  const sheetDoc = xml(decode(await zip.read(target)));
  const rows = [];
  for (const row of sheetDoc.querySelectorAll('row')) {
    const values = [];
    for (const cell of row.querySelectorAll('c')) {
      const ref = cell.getAttribute('r') || '';
      const type = cell.getAttribute('t') || 'n';
      let value = null;
      if (type === 'inlineStr') {
        value = [...cell.querySelectorAll('is t')].map(t => t.textContent).join('');
      } else {
        const raw = cell.querySelector('v')?.textContent;
        if (raw != null) {
          if (type === 's') value = shared[Number(raw)] ?? '';
          else if (type === 'str') value = raw;
          else value = Number(raw);
        }
      }
      if (value !== null) values[columnIndex(ref)] = value;
    }
    rows.push(values);
  }
  return rows;
}
