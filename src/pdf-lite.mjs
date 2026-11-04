// Мини-генератор PDF без зависимостей (по образцу xlsx-lite): страницы
// A4, TrueType-шрифт с кириллицей встраивается целиком (CIDFontType2 +
// Identity-H + ToUnicode), примитивы — текст, линия, прямоугольник,
// полилиния, круг, векторный путь (SVG-подмножество M/L/H/V/C/Z — им
// рисуется знак «Пегас-Авто»). Потоки и шрифт сжимаются FlateDecode (node:zlib).
// Система координат наружу — привычная экранная: y растёт ВНИЗ от
// верхнего края страницы; в PDF переводится при записи.
import fs from 'node:fs';
import zlib from 'node:zlib';

export const A4 = { w: 595.28, h: 841.89 };

// Печатная (светлая) палитра бренд-платформы «Пегас-Авто» — общая для всех
// PDF планера: ультрамарин, нейтрали, смысловые цвета и цвета отделов
// (КТГ — ТОиР, КВЛ — Эксплуатация, КИП — Логистика).
export const BRAND = {
  u900: '#15265e', u800: '#1b2f7a', u700: '#24409c', u600: '#2a44a0', u500: '#3a57c4',
  u400: '#5b7be6', u300: '#8aa4f2', u200: '#c3d0f7', u100: '#e7ecfb', brand: '#2f49b0',
  canvas: '#eef1f8', panel: '#ffffff', panel2: '#f2f5fc', ink: '#141b2e', muted: '#525d78',
  faint: '#8793ad', border: '#d9deec', border2: '#ebeef6', accent: '#2a44a0',
  accentSoft: '#e7ecfb', thBg: '#1b2f7a', pos: '#1f8a5b', neg: '#c23b43', warn: '#b07a1e',
  logo: '#294894',
  hq: '#8a5f1a', logistics: '#1f54a8', ops: '#1b744d', repair: '#166b70'
};

// Знак «Пегас-Авто» (одноцветный контур из public/assets/brand/pegas-logo.svg):
// читается с диска один раз при загрузке модуля; рисуется pdf.logo().
const LOGO_SVG = fs.readFileSync(new URL('../public/assets/brand/pegas-logo.svg', import.meta.url), 'utf8');
const LOGO_BOX = (LOGO_SVG.match(/viewBox="([^"]+)"/)?.[1] || '0 0 228 140').split(/\s+/).map(Number);
export const PEGAS_LOGO = { d: LOGO_SVG.match(/\sd="([^"]+)"/)?.[1] || '', w: LOGO_BOX[2], h: LOGO_BOX[3] };

// ── Разбор TrueType: unitsPerEm, ширины глифов, cmap символ→глиф ──
function parseTtf(buffer) {
  const u16 = offset => buffer.readUInt16BE(offset);
  const u32 = offset => buffer.readUInt32BE(offset);
  const tableCount = u16(4);
  const tables = new Map();
  for (let i = 0; i < tableCount; i += 1) {
    const base = 12 + i * 16;
    tables.set(buffer.toString('latin1', base, base + 4), { off: u32(base + 8), len: u32(base + 12) });
  }
  const need = name => {
    const table = tables.get(name);
    if (!table) throw new Error(`TTF без таблицы ${name}`);
    return table;
  };
  const head = need('head').off;
  const unitsPerEm = u16(head + 18);
  const numGlyphs = u16(need('maxp').off + 4);
  const numberOfHMetrics = u16(need('hhea').off + 34);
  const hmtx = need('hmtx').off;
  const advances = new Array(numGlyphs);
  let last = 600;
  for (let gid = 0; gid < numGlyphs; gid += 1) {
    if (gid < numberOfHMetrics) last = u16(hmtx + gid * 4);
    advances[gid] = last;
  }
  // cmap: ищем Unicode-подтаблицу format 4 (BMP хватает: кириллица там).
  const cmap = need('cmap').off;
  let sub = 0;
  for (let i = 0, n = u16(cmap + 2); i < n; i += 1) {
    const platform = u16(cmap + 4 + i * 8);
    const encoding = u16(cmap + 6 + i * 8);
    if ((platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0) {
      sub = cmap + u32(cmap + 8 + i * 8);
      if (u16(sub) === 4) break;
    }
  }
  if (!sub || u16(sub) !== 4) throw new Error('TTF без cmap format 4');
  const segCount = u16(sub + 6) / 2;
  const ends = [], starts = [], deltas = [], rangeOff = [];
  for (let i = 0; i < segCount; i += 1) {
    ends.push(u16(sub + 14 + i * 2));
    starts.push(u16(sub + 16 + segCount * 2 + i * 2));
    deltas.push(buffer.readInt16BE(sub + 16 + segCount * 4 + i * 2));
    rangeOff.push(u16(sub + 16 + segCount * 6 + i * 2));
  }
  const glyphOf = code => {
    for (let i = 0; i < segCount; i += 1) {
      if (code > ends[i] || code < starts[i]) continue;
      if (!rangeOff[i]) return (code + deltas[i]) & 0xffff;
      const at = sub + 16 + segCount * 6 + i * 2 + rangeOff[i] + (code - starts[i]) * 2;
      const gid = u16(at);
      return gid ? (gid + deltas[i]) & 0xffff : 0;
    }
    return 0;
  };
  return { unitsPerEm, advances, glyphOf, numGlyphs };
}

const colorOf = hex => {
  const value = String(hex).replace('#', '');
  return [0, 2, 4].map(i => (parseInt(value.slice(i, i + 2), 16) / 255).toFixed(3)).join(' ');
};
const num = value => (Math.round(value * 100) / 100).toString();

export class PdfLite {
  // landscape: true — альбомный A4 (презентации); по умолчанию портрет.
  constructor({ landscape = false } = {}) {
    this.w = landscape ? A4.h : A4.w;
    this.h = landscape ? A4.w : A4.h;
    this.fonts = new Map(); // имя → {ttf, buffer, used: Map(gid→code)}
    this.pages = [];
    this.current = null;
  }

  addFont(name, buffer) {
    this.fonts.set(name, { ttf: parseTtf(buffer), buffer, used: new Map() });
  }

  page() {
    this.current = { ops: [] };
    this.pages.push(this.current);
    return this;
  }

  width(text, size, font = 'R') {
    const f = this.fonts.get(font);
    let w = 0;
    for (const ch of String(text)) w += f.ttf.advances[f.ttf.glyphOf(ch.codePointAt(0))] || 600;
    return w / f.ttf.unitsPerEm * size;
  }

  // align: left (умолч.) | center | right — относительно x.
  text(x, y, value, { size = 10, font = 'R', color = BRAND.ink, align = 'left' } = {}) {
    const f = this.fonts.get(font);
    const str = String(value);
    const w = this.width(str, size, font);
    const tx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x;
    let hex = '';
    for (const ch of str) {
      const code = ch.codePointAt(0);
      const gid = f.ttf.glyphOf(code) || 0;
      f.used.set(gid, code);
      hex += gid.toString(16).padStart(4, '0');
    }
    this.current.ops.push(`BT /${font} ${num(size)} Tf ${colorOf(color)} rg ${num(tx)} ${num(this.h - y)} Td <${hex}> Tj ET`);
    return w;
  }

  line(x1, y1, x2, y2, { color = BRAND.border, width = 0.7 } = {}) {
    this.current.ops.push(`${colorOf(color)} RG ${num(width)} w ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`);
  }

  rect(x, y, w, h, { fill, stroke, width = 0.7 } = {}) {
    const parts = [`${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re`];
    if (fill) parts.unshift(`${colorOf(fill)} rg`);
    if (stroke) parts.unshift(`${colorOf(stroke)} RG ${num(width)} w`);
    parts.push(fill && stroke ? 'B' : fill ? 'f' : 'S');
    this.current.ops.push(parts.join(' '));
  }

  // dash — пунктир [штрих, зазор] в pt: КВЛ рисуется пунктиром, чтобы
  // не сливаться с КТГ (бирюза ТОиР и зелёный Эксплуатации близки).
  poly(points, { color = BRAND.accent, width = 1.4, dash = null } = {}) {
    if (points.length < 2) return;
    const path = points.map(([x, y], i) => `${num(x)} ${num(this.h - y)} ${i ? 'l' : 'm'}`).join(' ');
    const pattern = dash ? `[${dash.map(num).join(' ')}] 0 d ` : '';
    this.current.ops.push(`q ${colorOf(color)} RG ${num(width)} w 1 j 1 J ${pattern}${path} S Q`);
  }

  circle(cx, cy, r, { fill = BRAND.accent } = {}) {
    const k = 0.5523 * r;
    const y = this.h - cy;
    this.current.ops.push(`${colorOf(fill)} rg ${num(cx + r)} ${num(y)} m ` +
      `${num(cx + r)} ${num(y + k)} ${num(cx + k)} ${num(y + r)} ${num(cx)} ${num(y + r)} c ` +
      `${num(cx - k)} ${num(y + r)} ${num(cx - r)} ${num(y + k)} ${num(cx - r)} ${num(y)} c ` +
      `${num(cx - r)} ${num(y - k)} ${num(cx - k)} ${num(y - r)} ${num(cx)} ${num(y - r)} c ` +
      `${num(cx + k)} ${num(y - r)} ${num(cx + r)} ${num(y - k)} ${num(cx + r)} ${num(y)} c f`);
  }

  // Векторный путь в синтаксисе SVG (абсолютные M/L/H/V/C/Z, повторы
  // координат без буквы — как в SVG): (x, y) — левый верх, scale — масштаб
  // единиц пути. Заливка по правилу even-odd, как fill-rule="evenodd".
  path(d, { x = 0, y = 0, scale = 1, fill = BRAND.ink, evenOdd = true } = {}) {
    const tokens = String(d).match(/[MLHVCZmlhvcz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/g) || [];
    const px = v => num(x + v * scale);
    const py = v => num(this.h - (y + v * scale));
    const ops = [];
    let cmd = '', i = 0, cx = 0, cy = 0;
    const next = () => Number(tokens[i++]);
    while (i < tokens.length) {
      if (/[A-Za-z]/.test(tokens[i])) {
        cmd = tokens[i++].toUpperCase();
        if (cmd === 'Z') { ops.push('h'); continue; }
      }
      if (cmd === 'M') {
        cx = next(); cy = next();
        ops.push(`${px(cx)} ${py(cy)} m`);
        cmd = 'L'; // по SVG: координаты после M без буквы — это L
      } else if (cmd === 'L') {
        cx = next(); cy = next();
        ops.push(`${px(cx)} ${py(cy)} l`);
      } else if (cmd === 'H') {
        cx = next(); ops.push(`${px(cx)} ${py(cy)} l`);
      } else if (cmd === 'V') {
        cy = next(); ops.push(`${px(cx)} ${py(cy)} l`);
      } else if (cmd === 'C') {
        const a = [next(), next(), next(), next(), next(), next()];
        cx = a[4]; cy = a[5];
        ops.push(`${px(a[0])} ${py(a[1])} ${px(a[2])} ${py(a[3])} ${px(a[4])} ${py(a[5])} c`);
      } else {
        i += 1; // неизвестная команда — пропуск числа, без зацикливания
      }
    }
    if (ops.length) this.current.ops.push(`${colorOf(fill)} rg ${ops.join(' ')} ${evenOdd ? 'f*' : 'f'}`);
  }

  // Знак «Пегас-Авто» высотой height (ширина — по пропорции знака);
  // возвращает ширину. Ставится на белую подложку — её рисует вызывающий.
  logo(x, y, height, { color = BRAND.logo } = {}) {
    const scale = height / PEGAS_LOGO.h;
    this.path(PEGAS_LOGO.d, { x, y, scale, fill: color });
    return PEGAS_LOGO.w * scale;
  }

  build() {
    const objects = []; // строки/буферы тел объектов, 1-based
    const add = body => { objects.push(body); return objects.length; };
    const fontIds = new Map();
    for (const [name, f] of this.fonts) {
      const scale = 1000 / f.ttf.unitsPerEm;
      const fileData = zlib.deflateSync(f.buffer);
      const fileId = add({ stream: fileData,
        dict: `<< /Length ${fileData.length} /Length1 ${f.buffer.length} /Filter /FlateDecode >>` });
      const descId = add(`<< /Type /FontDescriptor /FontName /${name}-DejaVu /Flags 32
        /FontBBox [-1021 -463 1793 1232] /ItalicAngle 0 /Ascent 928 /Descent -236
        /CapHeight 730 /StemV 90 /FontFile2 ${fileId} 0 R >>`);
      // Ширины использованных глифов + ToUnicode для копирования текста.
      const used = [...f.used.entries()].sort((a, b) => a[0] - b[0]);
      const wParts = used.map(([gid]) => `${gid} [${Math.round(f.ttf.advances[gid] * scale)}]`);
      const bf = used.map(([gid, code]) =>
        `<${gid.toString(16).padStart(4, '0')}> <${code.toString(16).padStart(4, '0')}>`);
      const cmapText = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
/CMapName /A currentdict /CMap defineresource pop 1 begincodespacerange <0000> <ffff> endcodespacerange
${bf.length} beginbfchar
${bf.join('\n')}
endbfchar endcmap end end`;
      const cmapData = zlib.deflateSync(Buffer.from(cmapText));
      const cmapId = add({ stream: cmapData, dict: `<< /Length ${cmapData.length} /Filter /FlateDecode >>` });
      const cidId = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /${name}-DejaVu
        /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >>
        /FontDescriptor ${descId} 0 R /DW 600 /W [${wParts.join(' ')}] /CIDToGIDMap /Identity >>`);
      fontIds.set(name, add(`<< /Type /Font /Subtype /Type0 /BaseFont /${name}-DejaVu
        /Encoding /Identity-H /DescendantFonts [${cidId} 0 R] /ToUnicode ${cmapId} 0 R >>`));
    }
    const fontRes = [...fontIds].map(([name, id]) => `/${name} ${id} 0 R`).join(' ');
    const pageIds = [];
    const pagesId = objects.length + this.pages.length * 2 + 1;
    for (const page of this.pages) {
      const content = zlib.deflateSync(Buffer.from(page.ops.join('\n')));
      const contentId = add({ stream: content, dict: `<< /Length ${content.length} /Filter /FlateDecode >>` });
      pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${this.w} ${this.h}]
        /Resources << /Font << ${fontRes} >> >> /Contents ${contentId} 0 R >>`));
    }
    const realPagesId = add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`);
    if (realPagesId !== pagesId) throw new Error('PDF: разъехалась нумерация объектов');
    const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

    const chunks = [Buffer.from('%PDF-1.4\n%\xc2\xb5\xc2\xb6\n', 'latin1')];
    const offsets = [0];
    let position = chunks[0].length;
    objects.forEach((body, index) => {
      offsets.push(position);
      const head = Buffer.from(`${index + 1} 0 obj\n`);
      const tail = Buffer.from('\nendobj\n');
      const mid = typeof body === 'string'
        ? Buffer.from(body)
        : Buffer.concat([Buffer.from(`${body.dict}\nstream\n`), body.stream, Buffer.from('\nendstream')]);
      const chunk = Buffer.concat([head, mid, tail]);
      chunks.push(chunk);
      position += chunk.length;
    });
    const xrefAt = position;
    let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (let i = 1; i <= objects.length; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    chunks.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefAt}\n%%EOF`));
    return Buffer.concat(chunks);
  }
}
