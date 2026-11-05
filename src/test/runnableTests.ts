/**
 * Tests for runnable extraction and trigger (RTE event) mapping.
 *
 * Covers every trigger flavour plus the edge cases that broke naive parsers:
 *   - INTERNAL-BEHAVIOR short name must not leak into the component name
 *   - events declared before the runnables they activate
 *   - runnables with no activation path (orphans)
 *   - components without any internal behavior
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseArxml } from '../parser/arxmlParser';
import { buildViewModel } from '../parser/viewModel';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const file = path.resolve(__dirname, '../../samples/runnable/RunnableDemo.arxml');

function main() {
  console.log('\n=== runnable extraction ===');
  const doc = parseArxml(fs.readFileSync(file, 'utf8'), file, {});
  const swc = doc.swcs.find((s) => s.name === 'SpeedCtrl');

  check('component name is not overwritten by INTERNAL-BEHAVIOR', !!swc, doc.swcs.map((s) => s.name));
  check('hasInternalBehavior flag set', swc?.hasInternalBehavior === true);
  check('6 runnables parsed', swc?.runnables?.length === 6, swc?.runnables?.length);

  const byName = new Map((swc?.runnables ?? []).map((r) => [r.name, r]));

  const r10 = byName.get('Runnable_10ms');
  check('Runnable_10ms CAN-ENTER true', r10?.canEnter === true, r10?.canEnter);
  check('Runnable_10ms RUNS-ON resolved', r10?.runsOn === 'RTE', r10?.runsOn);
  check('Runnable_10ms min interval captured', r10?.minInterval === '0.01', r10?.minInterval);
  check('Runnable_10ms symbols captured', (r10?.symbols ?? []).join(',') === 'Rte_Runnable_SpeedCtrl_10ms', r10?.symbols);
  check('Runnable_10ms has exactly 1 trigger', r10?.triggers.length === 1, r10?.triggers);
  check('Runnable_10ms triggered by TimingEvent', r10?.triggers[0]?.kind === 'TimingEvent', r10?.triggers[0]);
  check('timing period formatted as 10 ms', r10?.triggers[0]?.detail === '10 ms', r10?.triggers[0]?.detail);
  check('timing event name captured', r10?.triggers[0]?.eventName === 'TimingEvent_10ms', r10?.triggers[0]?.eventName);

  const onSpeed = byName.get('Runnable_OnSpeed');
  check('Runnable_OnSpeed triggered by DataReceivedEvent', onSpeed?.triggers[0]?.kind === 'DataReceivedEvent', onSpeed?.triggers);
  check('data received port resolved', onSpeed?.triggers[0]?.port === 'VehicleSpeed_P', onSpeed?.triggers[0]?.port);

  const onDiag = byName.get('Runnable_OnDiag');
  check('Runnable_OnDiag CAN-ENTER false', onDiag?.canEnter === false, onDiag?.canEnter);
  check('Runnable_OnDiag triggered by OperationInvokedEvent', onDiag?.triggers[0]?.kind === 'OperationInvokedEvent', onDiag?.triggers);
  check('operation invoked port resolved', onDiag?.triggers[0]?.port === 'Diag_P', onDiag?.triggers[0]?.port);

  const onMode = byName.get('Runnable_OnMode');
  check('Runnable_OnMode triggered by ModeSwitchEvent', onMode?.triggers[0]?.kind === 'ModeSwitchEvent', onMode?.triggers);
  check('mode switch detail keeps transition', (onMode?.triggers[0]?.detail ?? '').includes('0'), onMode?.triggers[0]?.detail);
  check('Runnable_OnMode runs on SCHM', onMode?.runsOn === 'SCHM', onMode?.runsOn);

  const init = byName.get('Runnable_Init');
  check('Runnable_Init triggered by InitEvent', init?.triggers[0]?.kind === 'InitEvent', init?.triggers);

  const orphan = byName.get('Runnable_Orphan');
  check('orphan runnable has no trigger', (orphan?.triggers ?? []).length === 0, orphan?.triggers);
  check('orphan runnable runs on RTE', orphan?.runsOn === 'RTE');

  console.log('\n=== component without internal behavior ===');
  const passive = doc.swcs.find((s) => s.name === 'Passive');
  check('passive component still parsed', !!passive);
  check('passive component has no runnables', (passive?.runnables ?? []).length === 0);
  check('passive component has no behavior flag', !passive?.hasInternalBehavior);

  console.log('\n=== view model rows ===');
  const vm = buildViewModel(doc);
  check('6 runnable rows', vm.runnables.length === 6, vm.runnables.length);
  check('stats runnableCount', vm.stats.runnableCount === 6, vm.stats.runnableCount);
  check('stats orphanRunnables', vm.stats.orphanRunnables === 1, vm.stats.orphanRunnables);

  const row10 = vm.runnables.find((r) => r.name === 'Runnable_10ms');
  check('row carries swc owner', row10?.swc === 'SpeedCtrl', row10?.swc);
  check('row trigger summary is human readable', row10?.triggers === 'Timing 10 ms', row10?.triggers);
  check('row kinds list', (row10?.kinds ?? []).join(',') === 'TimingEvent', row10?.kinds);
  check('row canEnter yes', row10?.canEnter === 'yes', row10?.canEnter);
  check('row interval populated', row10?.interval === '10 ms', row10?.interval);
  check('row status ok', row10?.status === 'ok', row10?.status);

  const rowSpeed = vm.runnables.find((r) => r.name === 'Runnable_OnSpeed');
  check('data event row shows port', rowSpeed?.ports === 'VehicleSpeed_P', rowSpeed?.ports);
  check('data event summary includes port', (rowSpeed?.triggers ?? '').includes('VehicleSpeed_P'), rowSpeed?.triggers);

  const rowOrphan = vm.runnables.find((r) => r.name === 'Runnable_Orphan');
  check('orphan row status', rowOrphan?.status === 'orphan', rowOrphan?.status);
  check('orphan row has empty triggers', rowOrphan?.triggers === '', rowOrphan?.triggers);

  const rowDiag = vm.runnables.find((r) => r.name === 'Runnable_OnDiag');
  check('canEnter false rendered as no', rowDiag?.canEnter === 'no', rowDiag?.canEnter);

  console.log('\n=== regression: files without internal behavior ===');
  const demo = path.resolve(__dirname, '../../samples/demo_vehicle.arxml');
  const demoVm = buildViewModel(parseArxml(fs.readFileSync(demo, 'utf8'), demo, {}));
  check('demo has zero runnables', demoVm.runnables.length === 0, demoVm.runnables.length);
  check('demo connections unaffected', demoVm.connections.length > 0, demoVm.connections.length);
  check(
    'demo interface rows unaffected',
    demoVm.interfaces.length > 0 && demoVm.interfaces.every((i) => !!i.category),
    demoVm.interfaces.length
  );

  console.log(`\n${failures === 0 ? 'ALL PASS' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
