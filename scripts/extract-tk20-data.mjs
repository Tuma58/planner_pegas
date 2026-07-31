import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const sourcePath = path.resolve(process.argv[2] || '/Users/admin/Downloads/Диспетчерская_ТК_20.html');
const outputPath = path.resolve(process.argv[3] || 'src/tk20-data.json');
const html = fs.readFileSync(sourcePath, 'utf8');

function evaluateDeclaration(name, nextMarker) {
  const start = html.indexOf(`const ${name}=`);
  const end = html.indexOf(nextMarker, start);
  if (start < 0 || end < 0) throw new Error(`Не удалось извлечь ${name}`);
  const source = html.slice(start, end).replace(`const ${name}=`, `globalThis.${name}=`);
  const context = {};
  vm.runInNewContext(source, context, { timeout: 5_000 });
  return JSON.parse(JSON.stringify(context[name]));
}

const payload = {
  version: 20,
  sourceFile: path.basename(sourcePath),
  sourceSha256: createHash('sha256').update(html).digest('hex'),
  horizonStart: '2026-07-01',
  vehicles: evaluateDeclaration('TRUCKS', 'const PLAN_REAL='),
  trips: evaluateDeclaration('PLAN_REAL', 'const CLIENTS_FULL='),
  customers: evaluateDeclaration('CLIENTS_FULL', 'const START=')
};

fs.writeFileSync(outputPath, `${JSON.stringify(payload)}\n`);
console.log(`Создан ${outputPath}: ${payload.vehicles.length} ТС, ${payload.trips.length} рейсов, ${payload.customers.length} клиентов`);
