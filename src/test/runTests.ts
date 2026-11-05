/**
 * Plain-node test runner (no vscode dependency) for the parser + view model.
 * Run with: npm test
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseArxml } from '../parser/arxmlParser';
import { buildViewModel, toCsv } from '../parser/viewModel';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

function main() {
  const file = path.resolve(__dirname, '../../samples/demo_vehicle.arxml');
  const xml = fs.readFileSync(file, 'utf8');
  const doc = parseArxml(xml, file);
  const vm = buildViewModel(doc);

  console.log(`\nParsed ${doc.stats.elements} elements in ${doc.stats.elapsedMs} ms`);
  console.log(`SWCs: ${vm.stats.swcCount}, ports: ${vm.stats.portCount}, connectors: ${vm.connections.length}\n`);

  check('schema version detected', doc.schemaVersion === '4.0', doc.schemaVersion);
  check('7 standalone SWC types found', doc.swcs.length === 7, doc.swcs.map((s) => s.name));
  check('2 compositions found', doc.compositions.length === 2, doc.compositions.map((c) => c.name));
  check('EngineControl has 5 ports', doc.swcs.find((s) => s.name === 'EngineControl')?.ports.length === 5);
  check('EngineSpeed_I has 2 data elements',
    doc.interfaces.get('/Interfaces/EngineSpeed_I')?.dataElements.length === 2,
    doc.interfaces.get('/Interfaces/EngineSpeed_I'));
  check('port resolves data elements',
    (doc.swcs.find((s) => s.name === 'EngineControl')?.ports.find((p) => p.name === 'EngineSpeed_P')?.dataElements ?? []).includes('EngineSpeed'));
  check('assembly connectors parsed', vm.stats.assemblyCount === 7, vm.stats.assemblyCount);
  check('delegation connector parsed', vm.stats.delegateCount === 1, vm.stats.delegateCount);

  const wheelAbs = vm.connections.find(
    (c) => c.providerComponent === 'WheelSpeedSensorInst' && c.requesterComponent === 'ABS'
  );
  check('WheelSpeedSensor -> ABS connection exists', !!wheelAbs, vm.connections.map((c) => `${c.providerComponent}->${c.requesterComponent}`));
  check('connection keeps provider port name', wheelAbs?.providerPort === 'VehicleSpeed_P', wheelAbs?.providerPort);

  const unconnected = vm.ports.find((p) => p.port === 'Unused_R');
  check('unconnected port detected', unconnected?.status === 'unconnected', unconnected?.status);

  check('CSV header correct', toCsv(vm).startsWith('Provider SWC,Provider Port,Provider Interface'));
  check('CSV line count matches connections', toCsv(vm).trim().split('\r\n').length === vm.connections.length + 1);

  // --- large file smoke test ------------------------------------------------
  const bigParts: string[] = [];
  bigParts.push('<?xml version="1.0" encoding="UTF-8"?><AUTOSAR xmlns="http://autosar.org/schema/r4.0"><AR-PACKAGES><AR-PACKAGE><SHORT-NAME>Big</SHORT-NAME><ELEMENTS>');
  for (let i = 0; i < 3000; i++) {
    bigParts.push(
      `<APPLICATION-SW-COMPONENT-TYPE><SHORT-NAME>Swc_${i}</SHORT-NAME><PORTS>` +
        `<P-PORT-PROTOTYPE><SHORT-NAME>Out_${i}</SHORT-NAME><PROVIDED-INTERFACE-TREF>/I/If_${i}</PROVIDED-INTERFACE-TREF></P-PORT-PROTOTYPE>` +
        `<R-PORT-PROTOTYPE><SHORT-NAME>In_${i}</SHORT-NAME><REQUIRED-INTERFACE-TREF>/I/If_${i - 1}</REQUIRED-INTERFACE-TREF></R-PORT-PROTOTYPE>` +
        `</PORTS></APPLICATION-SW-COMPONENT-TYPE>`
    );
  }
  for (let i = 1; i < 3000; i++) {
    bigParts.push(
      `<ASSEMBLY-SW-CONNECTOR><PROVIDER-IREF><TARGET-PORT-REF>/Big/Swc_${i - 1}/Out_${i - 1}</TARGET-PORT-REF></PROVIDER-IREF>` +
        `<REQUESTER-IREF><TARGET-PORT-REF>/Big/Swc_${i}/In_${i}</TARGET-PORT-REF></REQUESTER-IREF></ASSEMBLY-SW-CONNECTOR>`
    );
  }
  bigParts.push('</ELEMENTS></AR-PACKAGE></AR-PACKAGES></AUTOSAR>');
  const bigXml = bigParts.join('\n');
  const t0 = Date.now();
  const bigDoc = parseArxml(bigXml, 'big.arxml');
  const elapsed = Date.now() - t0;
  const bigVm = buildViewModel(bigDoc);
  console.log(`\nLarge file: ${(bigXml.length / 1024).toFixed(0)} KB, ${bigDoc.stats.elements} elements, ${elapsed} ms`);
  check('large file: 3000 SWCs', bigDoc.swcs.length === 3000, bigDoc.swcs.length);
  check('large file: 2999 connectors', bigVm.connections.length === 2999, bigVm.connections.length);
  check('large file: parses under 5s', elapsed < 5000, `${elapsed}ms`);
  check('large file: Swc_0 provider resolved', bigVm.connections[0].providerComponent === 'Swc_0', bigVm.connections[0]);

  console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
