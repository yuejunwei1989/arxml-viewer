import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { parseArxml, ArxmlParseError } from './parser/arxmlParser';
import { collectArxmlFiles, parseArxmlProject } from './parser/projectParser';
import { discoverDaVinciProject, expandDaVinciProject, isDaVinciProjectFile } from './parser/davinciProject';
import { buildProjectViewModel, buildViewModel, projectToCsv, toCsv, ViewModel } from './parser/viewModel';
import { ArxmlDocument, ArxmlProject } from './parser/model';

const VIEW_TYPE = 'arxmlSwc.tableView';

type Scope = 'file' | 'folder' | 'workspace' | 'picked';

interface LoadResult {
  vm: ViewModel & { error?: string };
  project?: ArxmlProject;
}

export class ArxmlTableEditorProvider implements vscode.CustomTextEditorProvider {
  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE,
      new ArxmlTableEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false,
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  async resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    // Scope is per editor panel: one tab can show a folder while another shows
    // a single file.
    let scope = this.initialScope(document);
    let pickedFolder: string | undefined;
    let lastProject: ArxmlProject | undefined;
    let initialised = false;

    const render = async (notify = false) => {
      const result = await this.load(document, scope, pickedFolder);
      lastProject = result.project;
      const vm = result.vm;

      if (!initialised) {
        panel.webview.html = renderHtml(panel.webview, this.context.extensionUri, vm, document.uri, scope);
        initialised = true;
      } else {
        // Keep the webview alive and just push fresh data: avoids flicker and
        // preserves the user's tab / scroll position.
        void panel.webview.postMessage({ type: 'update', data: vm, scope });
      }
      if (notify) {
        panel.title =
          scope === 'file'
            ? `SWC: ${path.basename(document.uri.fsPath)}`
            : `SWC project: ${result.vm.stats.fileCount} files`;
      }
    };

    // Re-parse on save. In project mode any saved .arxml under the scope
    // matters, not only the document this editor was opened for.
    const changeSub = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (scope === 'file') {
        if (doc.uri.toString() === document.uri.toString()) await render();
        return;
      }
      if (/\.arxml$/i.test(doc.uri.fsPath)) await render();
    });

    panel.webview.onDidReceiveMessage(async (msg) => {
      switch (msg?.type) {
        case 'ready':
          // the webview only asks once on load; html is already rendered
          break;
        case 'refresh':
          await render();
          break;
        case 'setScope': {
          const next = String(msg.scope ?? 'file') as Scope;
          if (next === 'picked') {
            const picked = await vscode.window.showOpenDialog({
              canSelectFolders: true,
              canSelectFiles: false,
              canSelectMany: false,
              openLabel: 'Select ARXML project folder',
            });
            if (!picked?.length) return;
            pickedFolder = picked[0].fsPath;
          }
          scope = next;
          await withProgress(panel, 'Parsing…', async () => render(true));
          break;
        }
        case 'openSource':
          await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        case 'openFile': {
          // open the ARXML file a row came from
          const p = String(msg.path ?? '');
          if (!p) return;
          await vscode.window.showTextDocument(vscode.Uri.file(p), { viewColumn: vscode.ViewColumn.Beside });
          break;
        }
        case 'revealLine': {
          const line = Number(msg.line);
          if (Number.isFinite(line) && line > 0) {
            const editor = await vscode.window.showTextDocument(document, { viewColumn: vscode.ViewColumn.Beside });
            const pos = new vscode.Position(Math.max(0, line - 1), 0);
            editor.selection = new vscode.Selection(pos, pos);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
          }
          break;
        }
        case 'copy': {
          await vscode.env.clipboard.writeText(String(msg.text ?? ''));
          vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
          break;
        }
        case 'saveCsv': {
          const csv = lastProject ? projectToCsv(lastProject, (await this.load(document, scope, pickedFolder)).vm) : toCsv((await this.load(document, scope, pickedFolder)).vm);
          const target = await vscode.window.showSaveDialog({
            filters: { CSV: ['csv'] },
            defaultUri: document.uri.with({ path: document.uri.path.replace(/\.arxml$/i, '.csv') }),
          });
          if (target) {
            await fs.promises.writeFile(target.fsPath, '\ufeff' + csv, 'utf8');
            vscode.window.showInformationMessage(`Exported ${path.basename(target.fsPath)}`);
          }
          break;
        }
        case 'error':
          vscode.window.showErrorMessage(String(msg.message ?? 'View error'));
          break;
      }
    });

    panel.onDidDispose(() => changeSub.dispose());
    await render();
  }

  /** Project mode is used when the setting asks for it and a folder exists. */
  private initialScope(document: vscode.TextDocument): Scope {
    const cfg = vscode.workspace.getConfiguration('arxmlSwc');
    if (!cfg.get<boolean>('projectMode', false)) return 'file';
    return cfg.get<string>('projectScope', 'folder') === 'workspace' ? 'workspace' : 'folder';
  }

  private async load(document: vscode.TextDocument, scope: Scope, pickedFolder?: string): Promise<LoadResult> {
    const cfg = vscode.workspace.getConfiguration('arxmlSwc');
    const patterns = cfg.get<string[]>('excludePatterns', []);
    let excludePattern: RegExp | undefined;
    if (patterns.length) {
      try {
        excludePattern = new RegExp(patterns.map((p) => `(?:${p})`).join('|'));
      } catch {
        excludePattern = undefined;
      }
    }

    // ---- Vector DaVinci project file (.dcf / .dpa / .dvjson) -------------
    if (document.uri.scheme === 'file' && isDaVinciProjectFile(document.uri.fsPath)) {
      const discovery = await discoverDaVinciProject(document.uri.fsPath);
      const files = await expandDaVinciProject(discovery);
      if (!files.length) {
        return {
          vm: errorViewModel(
            document.uri.fsPath,
            `No referenced ARXML file found for ${path.basename(document.uri.fsPath)}.\n` +
              (discovery.issues.map((i) => '· ' + i.message).join('\n') || '')
          ),
        };
      }
      try {
        const project = await parseArxmlProject(files, { excludePattern });
        project.daVinci = {
          projectFile: discovery.projectFile,
          kind: discovery.kind,
          tool: discovery.tool,
          root: discovery.root,
          externalProjects: discovery.externalProjects,
          scannedFolders: discovery.scannedFolders,
        };
        // discovery diagnostics (missing refs, fallbacks) belong in the issue tab
        project.issues.unshift(...discovery.issues);
        return { vm: buildProjectViewModel(project), project };
      } catch (e) {
        return { vm: errorViewModel(document.uri.fsPath, (e as Error).message) };
      }
    }

    // ---- project scope ---------------------------------------------------
    if (scope !== 'file') {
      const roots = this.scopeRoots(document, scope, pickedFolder);
      if (roots.length) {
        const ignore = cfg.get<string[]>('projectIgnore', []);
        const files = await collectArxmlFiles(roots, ignore);
        // Make sure the file this editor was opened for is always included.
        if (!files.includes(document.uri.fsPath)) files.unshift(document.uri.fsPath);
        try {
          const project = await parseArxmlProject(files, { excludePattern });
          return { vm: buildProjectViewModel(project), project };
        } catch (e) {
          return { vm: errorViewModel(document.uri.fsPath, (e as Error).message) };
        }
      }
    }

    // ---- single file -----------------------------------------------------
    try {
      const text = document.getText();
      const doc: ArxmlDocument = parseArxml(text, document.uri.fsPath, { excludePattern });
      const vm = buildViewModel(doc);
      vm.stats.fileCount = 1;
      return { vm };
    } catch (e) {
      const msg = e instanceof ArxmlParseError ? e.message : String((e as Error)?.message ?? e);
      return { vm: errorViewModel(document.uri.fsPath, msg) };
    }
  }

  private scopeRoots(document: vscode.TextDocument, scope: Scope, pickedFolder?: string): string[] {
    if (document.uri.scheme !== 'file') return []; // virtual FS: single-file only
    if (scope === 'folder') return [path.dirname(document.uri.fsPath)];
    if (scope === 'picked') return pickedFolder ? [pickedFolder] : [];
    if (scope === 'workspace') {
      return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    }
    return [];
  }
}

async function withProgress(panel: vscode.WebviewPanel, title: string, task: () => Promise<void>): Promise<void> {
  await vscode.window.withProgress(
    { location: { viewId: VIEW_TYPE } as never, title },
    task
  ).then(undefined, () => panel.webview.postMessage({ type: 'error', message: 'Parse failed' }));
}

function errorViewModel(file: string, message: string): ViewModel & { error?: string } {
  return {
    fileName: file,
    schemaVersion: '',
    projectMode: false,
    daVinci: null,
    files: [],
    issues: [],
    swcs: [],
    connections: [],
    ports: [],
    interfaces: [],
    dataTypes: [],
    runnables: [],
    matrix: { components: [], cells: [] },
    stats: {
      swcCount: 0,
      portCount: 0,
      assemblyCount: 0,
      delegateCount: 0,
      unconnectedPorts: 0,
      unresolvedCount: 0,
      elements: 0,
      elapsedMs: 0,
      fileCount: 0,
      failedFiles: 0,
      issueCount: 0,
      interfaceCount: 0,
      dataTypeCount: 0,
      runnableCount: 0,
      orphanRunnables: 0,
    },
    packages: [],
    error: message,
  };
}

function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  vm: ViewModel & { error?: string },
  docUri: vscode.Uri,
  scope: Scope
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'style.css'));
  const nonce = getNonce();
  const payload = JSON.stringify(vm).replace(/</g, '\\u003c');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<link rel="stylesheet" href="${styleUri}" />
<title>SWC Connections</title>
</head>
<body>
<div id="app" data-file="${escapeAttr(docUri.fsPath)}" data-scope="${scope}"></div>
<script nonce="${nonce}">window.__ARXML_DATA__ = ${payload};</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
