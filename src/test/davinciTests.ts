/**
 * Tests for Vector DaVinci project discovery (.dcf / .dpa / .dvjson) and the
 * end-to-end SWC extraction from those projects.
 */
import * as path from 'path';
import { discoverDaVinciProject, expandDaVinciProject, isDaVinciProjectFile } from '../parser/davinciProject';
import { parseArxmlProject } from '../parser/projectParser';
import { buildProjectViewModel } from '../parser/viewModel';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

const root = path.resolve(__dirname, '../../samples/davinci');

async function run(file: string, label: string, expected: { swcs: number; conns: number; comps: number }) {
  console.log(`\n=== ${label} : ${path.basename(file)} ===`);
  check('recognised as DaVinci project file', isDaVinciProjectFile(file));

  const discovery = await discoverDaVinciProject(file);
  console.log(`   kind=${discovery.kind} tool=${discovery.tool}`);
  console.log(`   referenced arxml: ${discovery.arxmlFiles.map((f) => path.basename(f)).join(', ')}`);
  console.log(`   scanned folders: ${discovery.scannedFolders.map((f) => path.basename(f)).join(', ') || '-'}`);

  const files = await expandDaVinciProject(discovery);
  const project = await parseArxmlProject(files);
  project.daVinci = {
    projectFile: discovery.projectFile,
    kind: discovery.kind,
    tool: discovery.tool,
    root: discovery.root,
    externalProjects: discovery.externalProjects,
    scannedFolders: discovery.scannedFolders,
  };
  project.issues.unshift(...discovery.issues);

  const vm = buildProjectViewModel(project);
  console.log(
    `   files=${files.length} swc=${vm.stats.swcCount} ports=${vm.stats.portCount} ` +
      `conns=${vm.connections.length} issues=${vm.issues.length} (${project.stats.elapsedMs} ms)`
  );

  check(`${label}: SWC count = ${expected.swcs}`, vm.stats.swcCount === expected.swcs, vm.swcs.map((s) => s.name));
  check(`${label}: connections = ${expected.conns}`, vm.connections.length === expected.conns,
    vm.connections.map((c) => `${c.providerComponent}->${c.requesterComponent}`));
  check(`${label}: composition found`, project.merged.compositions.length === expected.comps,
    project.merged.compositions.map((c) => c.name));
  check(`${label}: projectMode enabled`, vm.projectMode === true);
  check(`${label}: daVinci context attached`, vm.daVinci?.kind === discovery.kind, vm.daVinci);
  check(`${label}: all ports have a source file`, vm.ports.every((p) => p.sourceFile));

  return { discovery, vm, project };
}

async function main() {
  // ---------------- DaVinci Developer workspace (.dcf) --------------------
  const dev = await run(path.join(root, 'dev-workspace/DemoWorkspace.dcf'), 'Developer', {
    swcs: 3,
    conns: 2,
    comps: 1,
  });
  check('Developer: 3 filerefs resolved', dev.discovery.arxmlFiles.length === 3, dev.discovery.arxmlFiles.length);
  check(
    'Developer: missing ARXML silently skipped (not fatal)',
    !dev.discovery.arxmlFiles.some((f) => f.includes('MissingTypes')),
    dev.discovery.arxmlFiles
  );
  check(
    'Developer: cross-file interface resolved on every connection',
    dev.vm.connections.every((c) => c.providerInterface !== '' && c.requesterInterface !== ''),
    dev.vm.connections.map((c) => [c.providerInterface, c.requesterInterface])
  );
  const readerLogic = dev.vm.connections.find((c) => c.providerComponent === 'Reader' && c.requesterComponent === 'Logic');
  check('Developer: Reader->Logic connection', !!readerLogic, dev.vm.connections.map((c) => c.providerComponent + '->' + c.requesterComponent));
  check(
    'Developer: data element resolved across files',
    (readerLogic?.dataElements ?? '').includes('SwitchPosition'),
    readerLogic?.dataElements
  );

  // ---------------- DaVinci Configurator v5 (.dpa) -----------------------
  const v5 = await run(path.join(root, 'sys-v5/DemoV5.dpa'), 'ConfiguratorV5', {
    swcs: 3,
    conns: 2,
    comps: 1,
  });
  check('V5: nested Developer workspace discovered', v5.discovery.externalProjects.length === 1, v5.discovery.externalProjects);
  check('V5: folder scanned', v5.discovery.scannedFolders.length >= 1, v5.discovery.scannedFolders);
  check(
    'V5: BodyControl (app components) present',
    v5.vm.swcs.some((s) => s.name === 'BodyControl'),
    v5.vm.swcs.map((s) => s.name)
  );
  check(
    'V5: DoorSensor from nested workspace present',
    v5.vm.swcs.some((s) => s.name === 'DoorSensor'),
    v5.vm.swcs.map((s) => s.name)
  );

  // ---------------- DaVinci Configurator v6 (.dvjson) --------------------
  const v6 = await run(path.join(root, 'sys-v6/DemoV6.dvjson'), 'ConfiguratorV6', {
    swcs: 3,
    conns: 2,
    comps: 1,
  });
  check('V6: dvWorkspace resolved', v6.discovery.externalProjects.some((p) => p.endsWith('.dcf')), v6.discovery.externalProjects);
  check(
    'V6: component from AppComponents folder loaded',
    v6.vm.swcs.some((s) => s.name === 'ClimateControl'),
    v6.vm.swcs.map((s) => s.name)
  );
  check(
    'V6: composition from dv workspace loaded',
    v6.project.merged.compositions.some((c) => c.name === 'ClimateComposition'),
    v6.project.merged.compositions.map((c) => c.name)
  );

  // ---------------- edge cases -------------------------------------------
  console.log('\n=== edge cases ===');
  check('arxml is not a davinci project', !isDaVinciProjectFile('/x/a.arxml'));
  check('dcf is a davinci project', isDaVinciProjectFile('/x/a.dcf'));
  check('dvjson is a davinci project', isDaVinciProjectFile('/x/a.DVJSON'));

  const missing = await discoverDaVinciProject(path.join(root, 'dev-workspace/nope.dcf'));
  check('missing project file reports error issue', missing.issues.some((i) => i.code === 'PARSE_ERROR'), missing.issues);
  check('missing project file yields no arxml', missing.arxmlFiles.length === 0);

  console.log(failures === 0 ? '\nAll DaVinci checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
