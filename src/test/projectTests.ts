/**
 * Tests for multi-file project parsing: cross-file reference resolution,
 * duplicate detection, error isolation, and aggregation.
 * Run with: npm test
 */
import * as path from 'path';
import { collectArxmlFiles, parseArxmlProject } from '../parser/projectParser';
import { buildProjectViewModel, projectToCsv } from '../parser/viewModel';

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`);
  }
}

async function main() {
  const root = path.resolve(__dirname, '../../samples/project');
  const files = await collectArxmlFiles([root]);
  console.log(`\nScanned ${files.length} files under samples/project:`);
  for (const f of files) console.log('   ' + path.relative(root, f));

  const project = await parseArxmlProject(files);
  const vm = buildProjectViewModel(project);

  console.log(
    `\nParsed ${project.stats.fileCount} files in ${project.stats.elapsedMs} ms ` +
      `(${project.stats.failedFiles} failed), SWC=${vm.stats.swcCount}, connections=${vm.connections.length}`
  );

  // ---- file discovery ---------------------------------------------------
  check('collects all 7 arxml files', files.length === 7, files.length);

  // ---- error isolation --------------------------------------------------
  const broken = project.files.find((f) => f.name === 'broken_syntax.arxml');
  check('broken file recorded with error', !!broken?.error, broken);
  check('broken file does not block the project', project.stats.failedFiles === 1, project.stats.failedFiles);
  check(
    'parse error reported as issue',
    project.issues.some((i) => i.code === 'PARSE_ERROR'),
    project.issues.map((i) => i.code)
  );

  // ---- cross-file merge -------------------------------------------------
  const swcNames = project.merged.swcs.map((s) => s.name);
  check('SWCs merged from 2 component files', swcNames.length === 5, swcNames);
  check('EngineControl loaded from Powertrain file', swcNames.includes('EngineControl'));
  check('ABSCtrl loaded from Chassis file', swcNames.includes('ABSCtrl'));
  check('1 composition merged', project.merged.compositions.length === 1);

  // ---- cross-file interface resolution ----------------------------------
  const engine = project.merged.swcs.find((s) => s.name === 'EngineControl');
  const speedReq = engine?.ports.find((p) => p.name === 'VehicleSpeed_R');
  check('cross-file interface resolved (VehicleSpeed_I)', speedReq?.interfaceName === 'VehicleSpeed_I', speedReq?.interfaceName);
  check('cross-file data element resolved', (speedReq?.dataElements ?? []).includes('VehicleSpeed'), speedReq?.dataElements);
  check('missing interface flagged', project.issues.some((i) => i.message.includes('DoesNotExist_I')),
    project.issues.filter((i) => i.code === 'UNRESOLVED_REFERENCE').map((i) => i.message));
  check('missing component type flagged', project.issues.some((i) => i.message.includes('GhostComponent')));

  // ---- connectors from composition file ----------------------------------
  check('5 assembly connectors', vm.stats.assemblyCount === 5, vm.stats.assemblyCount);
  check('1 delegation connector', vm.stats.delegateCount === 1, vm.stats.delegateCount);

  const wheelAbs = vm.connections.find((c) => c.providerComponent === 'Wheel' && c.requesterComponent === 'ABS');
  check('cross-file connection Wheel->ABS found', !!wheelAbs);
  check('connection reports source file', (wheelAbs?.sourceFile ?? '').endsWith('VehicleTop.arxml'), wheelAbs?.sourceFile);

  // ---- duplicate detection ----------------------------------------------
  const dup = project.issues.filter((i) => i.code === 'DUPLICATE_DEFINITION');
  check('duplicate EngineControl reported once', dup.length === 1, dup.map((d) => d.message));
  check('duplicate issue lists both files', (dup[0]?.files.length ?? 0) === 2, dup[0]?.files);
  check('duplicate keeps 5 SWCs (no inflation)', project.merged.swcs.length === 5, project.merged.swcs.length);

  // ---- broken connector endpoint ----------------------------------------
  check(
    'broken connector endpoint flagged',
    project.issues.some((i) => i.message.includes('NoSuchPort')),
    project.issues.map((i) => i.message)
  );

  // ---- view model --------------------------------------------------------
  check('project mode flag set', vm.projectMode === true);
  check('files listed in view model', vm.files.length === 7, vm.files.length);
  check('issues exposed to view model', vm.issues.length > 0, vm.issues.length);
  check('ports have source file', vm.ports.every((p) => p.sourceFile.length > 0));
  check('connections deduped (6 unique)', vm.connections.length === 6, vm.connections.length);

  const csv = projectToCsv(project, vm);
  check('CSV has Files section', csv.includes('# Files'));
  check('CSV has Issues section', csv.includes('# Issues'));
  check('CSV contains every file', project.files.every((f) => csv.includes(f.name)));

  // ---- single-file project should behave like the plain view -------------
  const single = await parseArxmlProject([path.join(root, 'Interfaces/Chassis_If.arxml')]);
  const singleVm = buildProjectViewModel(single);
  check('single file project has projectMode=false', singleVm.projectMode === false);
  check('single file project parses 2 interfaces', single.files[0].interfaceCount === 2, single.files[0].interfaceCount);

  // ---- performance on many files ----------------------------------------
  const many = Array.from({ length: 40 }, () => path.join(root, 'Components/Chassis_SWC.arxml'));
  const t0 = Date.now();
  const bigProject = await parseArxmlProject(many);
  const elapsed = Date.now() - t0;
  console.log(`\n40 duplicate files parsed in ${elapsed} ms, issues=${bigProject.issues.length}`);
  check('many-file merge dedupes to 3 SWCs', bigProject.merged.swcs.length === 3, bigProject.merged.swcs.length);

  console.log(failures === 0 ? '\nAll project checks passed.' : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
