/**
 * Tests for the interface / data type views.
 *
 * Covers:
 *   - structured data elements with type references
 *   - client-server operations with IN/OUT arguments
 *   - the four data type flavours and their attributes
 *   - cross file resolution (interface -> type lives in another file)
 *   - the view model rows consumed by the webview
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseArxml } from '../parser/arxmlParser';
import { collectArxmlFiles, parseArxmlProject } from '../parser/projectParser';
import { buildProjectViewModel, buildViewModel } from '../parser/viewModel';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const sampleDir = path.resolve(__dirname, '../../samples/types');

async function main() {
  // ---------------------------------------------------------------------
  console.log('\n=== single file: interface + data type extraction ===');
  const file = path.join(sampleDir, 'DataTypes.arxml');
  const text = fs.readFileSync(file, 'utf8');
  const doc = parseArxml(text, file, {});

  check('4 sender-receiver / client-server interfaces parsed', doc.interfaces.size === 3, doc.interfaces.size);
  check('8 data types parsed', doc.dataTypes.size === 8, doc.dataTypes.size);

  const vs = doc.interfaces.get('/Interfaces/VehicleSpeed_I');
  check('VehicleSpeed_I found by full path', !!vs);
  check('VehicleSpeed_I has 2 structured data elements', (vs?.elements ?? []).length === 2, vs?.elements?.length);
  check('element SpeedValid references Boolean_T', vs?.elements?.[1]?.typeName === 'Boolean_T', vs?.elements?.[1]);
  check('element VehicleSpeed carries an INIT-VALUE', vs?.elements?.[0]?.hasInitValue === true);
  check('legacy dataElements list is backfilled', vs?.dataElements.join(',') === 'VehicleSpeed,SpeedValid', vs?.dataElements);

  const diag = doc.interfaces.get('/Interfaces/Diagnostics_I');
  check('Diagnostics_I parsed as client-server', diag?.category === 'CLIENT-SERVER-INTERFACE', diag?.category);
  check('Diagnostics_I flagged as service', diag?.isService === true);
  check('2 operations parsed', (diag?.operationDetails ?? []).length === 2, diag?.operationDetails?.length);
  check('ReadFaultMemory has 2 arguments', diag?.operationDetails?.[0]?.arguments.length === 2, diag?.operationDetails?.[0]);
  check(
    'ReadFaultMemory arg directions are IN / OUT',
    diag?.operationDetails?.[0]?.arguments.map((a) => a.direction).join(',') === 'IN,OUT',
    diag?.operationDetails?.[0]?.arguments
  );
  check(
    'ReadFaultMemory arg types resolved to IDT',
    diag?.operationDetails?.[0]?.arguments.map((a) => a.typeName).join(',') === 'DiagRequest_T,DiagResult_T',
    diag?.operationDetails?.[0]?.arguments
  );

  // ---- data types -----------------------------------------------------
  const speedT = doc.dataTypes.get('/DataTypes/VehicleSpeed_T');
  check('VehicleSpeed_T found', !!speedT);
  check('VehicleSpeed_T kind is APDT', speedT?.kind === 'APPLICATION-PRIMITIVE-DATA-TYPE', speedT?.kind);
  check('VehicleSpeed_T base type is uint16', speedT?.baseType === 'uint16', speedT?.baseType);
  check('VehicleSpeed_T unit resolved', speedT?.unit === 'kilometer_per_hour', speedT?.unit);
  check('VehicleSpeed_T compu method resolved', speedT?.compuMethod === 'kmh_CompuMethod', speedT?.compuMethod);
  check('VehicleSpeed_T category is VALUE', speedT?.category === 'VALUE', speedT?.category);

  const statusT = doc.dataTypes.get('/DataTypes/VehicleStatus_T');
  check('VehicleStatus_T is a record', statusT?.kind === 'APPLICATION-RECORD-DATA-TYPE', statusT?.kind);
  check('VehicleStatus_T has 4 members', statusT?.members.length === 4, statusT?.members?.length);
  check(
    'VehicleStatus_T member types resolved',
    statusT?.members.map((m) => m.name + ':' + m.typeName).join(',') ===
      'Speed:VehicleSpeed_T,EngineSpeed:EngineSpeed_T,CoolantTemp:Temperature_T,IsRunning:Boolean_T',
    statusT?.members
  );

  const arrT = doc.dataTypes.get('/DataTypes/WheelSpeedArray_T');
  check('WheelSpeedArray_T is an array', arrT?.kind === 'APPLICATION-ARRAY-DATA-TYPE', arrT?.kind);
  check('array element type is VehicleSpeed_T', arrT?.arrayElementType === 'VehicleSpeed_T', arrT?.arrayElementType);

  const idt = doc.dataTypes.get('/DataTypes/DiagRequest_T');
  check('DiagRequest_T is an IDT', idt?.kind === 'IMPLEMENTATION-DATA-TYPE', idt?.kind);
  check('DiagRequest_T base type uint8', idt?.baseType === 'uint8', idt?.baseType);

  // ---------------------------------------------------------------------
  console.log('\n=== view model rows ===');
  const vm = buildViewModel(doc);
  check('view model exposes 3 interface rows', vm.interfaces.length === 3, vm.interfaces.length);
  check('view model exposes 8 data type rows', vm.dataTypes.length === 8, vm.dataTypes.length);
  check('stats carry interfaceCount', vm.stats.interfaceCount === 3, vm.stats.interfaceCount);
  check('stats carry dataTypeCount', vm.stats.dataTypeCount === 8, vm.stats.dataTypeCount);

  const vsRow = vm.interfaces.find((r) => r.name === 'VehicleSpeed_I');
  check('VehicleSpeed_I classified as S/R', vsRow?.kind === 'S/R', vsRow?.kind);
  check('VehicleSpeed_I type column renders type kinds', /VehicleSpeed\s*:.*VehicleSpeed_T \[APDT\]/.test(vsRow?.types ?? ''), vsRow?.types);
  check('unused interface reports zero references', vsRow?.usedByCount === 0, vsRow?.usedBy);

  const diagRow = vm.interfaces.find((r) => r.name === 'Diagnostics_I');
  check('Diagnostics_I classified as C/S', diagRow?.kind === 'C/S', diagRow?.kind);
  check('Diagnostics_I row is marked as service', diagRow?.isService === true);
  check(
    'operation signature rendered with argument types',
    /ReadFaultMemory\(requestId:DiagRequest_T \[IDT\], result:DiagResult_T \[IDT\]\)/.test(diagRow?.types ?? ''),
    diagRow?.types
  );

  const recRow = vm.dataTypes.find((r) => r.name === 'VehicleStatus_T');
  check('record row kind label is Record', recRow?.kind === 'Record', recRow?.kind);
  check('record row lists 4 members', recRow?.memberCount === 4, recRow?.memberCount);
  check('record row is referenced by VehicleStatus_I', recRow?.usedByInterfaces === 'VehicleStatus_I', recRow?.usedByInterfaces);

  const arrRow = vm.dataTypes.find((r) => r.name === 'WheelSpeedArray_T');
  check('array row renders element type', arrRow?.members === '[] of VehicleSpeed_T', arrRow?.members);
  check('array row referenced by interface', arrRow?.usedByInterfaces === 'VehicleStatus_I', arrRow?.usedByInterfaces);

  const idtRow = vm.dataTypes.find((r) => r.name === 'DiagRequest_T');
  check('IDT row referenced by C/S interface', idtRow?.usedByInterfaces === 'Diagnostics_I', idtRow?.usedByInterfaces);

  // ---------------------------------------------------------------------
  console.log('\n=== project mode: types split across files ===');
  const files = await collectArxmlFiles([sampleDir]);
  check('collects the sample file', files.length === 1, files);
  const project = await parseArxmlProject(files);
  const pvm = buildProjectViewModel(project);
  check('project view keeps interface rows', pvm.interfaces.length === 3, pvm.interfaces.length);
  check('project view keeps data type rows', pvm.dataTypes.length === 8, pvm.dataTypes.length);

  // ---------------------------------------------------------------------
  console.log('\n=== regression: demo vehicle still parses ===');
  const demo = path.resolve(__dirname, '../../samples/demo_vehicle.arxml');
  const demoDoc = parseArxml(fs.readFileSync(demo, 'utf8'), demo, {});
  const dvm = buildViewModel(demoDoc);
  check('demo interfaces present', dvm.interfaces.length > 0, dvm.interfaces.length);
  check('demo connections unchanged', dvm.connections.length > 0, dvm.connections.length);
  check(
    'every demo interface row has a category',
    dvm.interfaces.every((r) => !!r.category),
    dvm.interfaces.filter((r) => !r.category).map((r) => r.name)
  );
  check(
    'connection rows carry the instance-to-type mapping',
    dvm.connections.some((c) => c.providerComponent === 'Engine' && c.providerComponentType === 'EngineControl'),
    dvm.connections.filter((c) => c.providerComponent === 'Engine').map((c) => c.providerComponentType)
  );

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
