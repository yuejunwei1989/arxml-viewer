// Screenshot harness: renders the webview bundles with real parsed data so the
// UI can be checked in a plain Chromium (no VS Code needed).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const out = path.join(root, 'out');
const media = path.join(root, 'media');
const tmp = path.join(root, '.shots');

const { parseArxml } = require(path.join(out, 'parser', 'arxmlParser.js'));
const { collectArxmlFiles, parseArxmlProject } = require(path.join(out, 'parser', 'projectParser.js'));
const { discoverDaVinciProject, expandDaVinciProject } = require(path.join(out, 'parser', 'davinciProject.js'));
const { buildViewModel, buildProjectViewModel } = require(path.join(out, 'parser', 'viewModel.js'));

fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });

function page(vm, activeTab, tag, detailSwc, detailTab) {
  const css = fs.readFileSync(path.join(media, 'style.css'), 'utf8');
  const js = fs.readFileSync(path.join(media, 'main.js'), 'utf8');
  const payload = JSON.stringify(vm).replace(/</g, '\\u003c');
  const scope = vm.projectMode ? 'folder' : 'file';
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><style>${css}</style></head>
<body><div id="app" data-file="C:/demo/demo_vehicle.arxml" data-scope="${scope}"></div>
<script>window.acquireVsCodeApi = function () { return { postMessage: function () {}, getState: function () { return {}; }, setState: function () {} }; };</script>
<script>window.__ARXML_DATA__ = ${payload};</script>
<script>${js}</script>
<script>
  const target = document.querySelector('[data-tab="${activeTab}"]');
  if (target) target.click();
  const swc = ${JSON.stringify(detailSwc || null)};
  if (swc) {
    const link = Array.from(document.querySelectorAll('a.comp-link')).find((a) => a.getAttribute('data-swc') === swc);
    if (link) link.click();
    const sub = document.querySelector('[data-detail-tab="${detailTab || 'connections'}"]');
    if (sub) sub.click();
  }
</script>
</body></html>`;
  const p = path.join(tmp, tag + '.html');
  fs.writeFileSync(p, html, 'utf8');
  return p;
}

function shoot(htmlPath, pngPath) {
  execFileSync('/usr/bin/chromium', [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1500,900',
    `--screenshot=${pngPath}`,
    'file://' + htmlPath,
  ], { stdio: 'ignore' });
  console.log('shot', path.relative(root, pngPath));
}

function walk(dir) {
  const acc = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) acc.push(...walk(p));
    else if (/\.arxml$/i.test(e.name)) acc.push(p);
  }
  return acc;
}

async function main() {
  const demo = parseArxml(
    fs.readFileSync(path.join(root, 'samples', 'demo_vehicle.arxml'), 'utf8'),
    'demo_vehicle.arxml'
  );
  const demoVm = buildViewModel(demo);

  const runnable = parseArxml(
    fs.readFileSync(path.join(root, 'samples', 'runnable', 'RunnableDemo.arxml'), 'utf8'),
    'RunnableDemo.arxml'
  );
  const runnableVm = buildViewModel(runnable);

  const types = parseArxml(
    fs.readFileSync(path.join(root, 'samples', 'types', 'DataTypes.arxml'), 'utf8'),
    'DataTypes.arxml'
  );
  const typesVm = buildViewModel(types);

  const projDir = path.join(root, 'samples', 'project');
  const files = walk(projDir);
  const project = await parseArxmlProject(files);
  const projectVm = buildProjectViewModel(project);

  const dcf = path.join(root, 'samples', 'davinci', 'dev-workspace', 'DemoWorkspace.dcf');
  const dvInfo = await discoverDaVinciProject(dcf);
  const dvFiles = await expandDaVinciProject(dvInfo);
  const dvProject = await parseArxmlProject(dvFiles);
  dvProject.daVinci = {
    projectFile: dvInfo.projectFile,
    kind: dvInfo.kind,
    tool: dvInfo.tool,
    root: dvInfo.root,
    externalProjects: dvInfo.externalProjects,
    scannedFolders: dvInfo.scannedFolders,
  };
  dvProject.issues.unshift(...dvInfo.issues);
  const dvVm = buildProjectViewModel(dvProject);

  const shots = [
    [demoVm, 'connections', 'shot-connections'],
    [demoVm, 'ports', 'shot-ports'],
    [demoVm, 'matrix', 'shot-matrix'],
    [projectVm, 'connections', 'shot-project-connections'],
    [projectVm, 'issues', 'shot-project-issues'],
    [demoVm, 'interfaces', 'shot-interfaces'],
    [typesVm, 'dataTypes', 'shot-datatypes'],
    [runnableVm, 'runnables', 'shot-runnables'],
    [dvVm, 'connections', 'shot-davinci'],
  ];

  for (const [vm, tab, name] of shots) {
    shoot(page(vm, tab, name), path.join(media, name + '.png'));
  }

  // SWC drill-down: one component, its connections and runnables split apart
  shoot(page(demoVm, 'swcs', 'swc-detail-connections', 'EngineControl', 'connections'),
    path.join(media, 'shot-swc-connections.png'));
  shoot(page(runnableVm, 'swcs', 'swc-detail-runnables', 'SpeedCtrl', 'runnables'),
    path.join(media, 'shot-swc-runnables.png'));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
