/**
 * Performance benchmark: 100 SWC x 100 ports x 10 data elements.
 *
 * Measures the three phases separately so a regression can be attributed:
 *   1. parse  (SAX -> model)
 *   2. view   (model -> table rows)
 *   3. total
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArxml } from '../parser/arxmlParser';
import { buildViewModel } from '../parser/viewModel';
import { DEFAULT_GEN, writeBenchmarkFile } from './genBenchmark';

function ms(t: number): string {
  return `${t.toFixed(1)} ms`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function main() {
  const tmp = path.join(os.tmpdir(), 'arxml-bench');
  console.log('generating benchmark fixture...');
  const gen = { ...DEFAULT_GEN };
  const t0 = Date.now();
  const file = writeBenchmarkFile(tmp, gen);
  const size = fs.statSync(file).size;
  console.log(
    `  ${gen.swcCount} SWC x ${gen.portsPerSwc} ports x ${gen.elementsPerPort} elements` +
      ` = ${gen.swcCount * gen.portsPerSwc} ports, ${gen.swcCount * gen.portsPerSwc * gen.elementsPerPort} data elements`
  );
  console.log(`  file: ${path.basename(file)} (${mb(size)}), generated in ${ms(Date.now() - t0)}`);

  const text = fs.readFileSync(file, 'utf8');

  // ---- warm up (JIT) ---------------------------------------------------
  parseArxml(text.slice(0, 0) + text, file, {});

  const runs = 3;
  const parseTimes: number[] = [];
  const viewTimes: number[] = [];
  let doc: ReturnType<typeof parseArxml> | undefined;

  for (let i = 0; i < runs; i++) {
    const a = Date.now();
    doc = parseArxml(text, file, {});
    parseTimes.push(Date.now() - a);

    const b = Date.now();
    buildViewModel(doc);
    viewTimes.push(Date.now() - b);
  }

  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const best = (a: number[]) => Math.min(...a);

  console.log('\n--- results ---');
  console.log(`parse : avg ${ms(avg(parseTimes))}  best ${ms(best(parseTimes))}  runs [${parseTimes.map(ms).join(', ')}]`);
  console.log(`view  : avg ${ms(avg(viewTimes))}  best ${ms(best(viewTimes))}  runs [${viewTimes.map(ms).join(', ')}]`);
  console.log(`total : avg ${ms(avg(parseTimes) + avg(viewTimes))}`);

  console.log('\n--- model ---');
  console.log(`  swcs        ${doc!.swcs.length}`);
  console.log(`  ports       ${doc!.swcs.reduce((n, s) => n + s.ports.length, 0)}`);
  console.log(`  connectors  ${doc!.connectors.length}`);
  console.log(`  interfaces  ${doc!.interfaces.size}`);
  console.log(`  dataTypes   ${doc!.dataTypes.size}`);
  console.log(`  runnables   ${doc!.swcs.reduce((n, s) => n + (s.runnables?.length ?? 0), 0)}`);
  console.log(`  elements    ${doc!.stats.elements}`);
  console.log(`  parseTime   ${ms(doc!.stats.elapsedMs)} (internal)`);
  console.log(`  throughput  ${(size / 1024 / 1024 / (avg(parseTimes) / 1000)).toFixed(1)} MB/s`);
}

main();
