import * as vscode from 'vscode';
import * as fs from 'fs';
import { ArxmlTableEditorProvider } from './tableEditor';
import { parseArxml } from './parser/arxmlParser';
import { buildViewModel, toCsv } from './parser/viewModel';

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(ArxmlTableEditorProvider.register(context));

  context.subscriptions.push(
    vscode.commands.registerCommand('arxmlSwc.showTableView', async (uri?: vscode.Uri) => {
      const target = resolveUri(uri);
      if (!target) {
        vscode.window.showWarningMessage('Right-click an .arxml file in the Explorer first.');
        return;
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'arxmlSwc.tableView');
    }),

    vscode.commands.registerCommand('arxmlSwc.openDaVinciProject', async (uri?: vscode.Uri) => {
      let target = uri;
      if (!target) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFiles: true,
          canSelectMany: false,
          openLabel: 'Select DaVinci project file',
          filters: { 'DaVinci project': ['dcf', 'dpa', 'dvjson'] },
        });
        if (!picked?.length) return;
        target = picked[0];
      }
      await vscode.commands.executeCommand('vscode.openWith', target, 'arxmlSwc.tableView');
    }),

    vscode.commands.registerCommand('arxmlSwc.showProjectView', async (uri?: vscode.Uri) => {
      const target = resolveUri(uri);
      if (!target) {
        vscode.window.showWarningMessage('Right-click an .arxml file in the Explorer first.');
        return;
      }
      // Force project mode for this panel by flipping the setting for the
      // workspace scope, then open the custom editor.
      await vscode.workspace
        .getConfiguration('arxmlSwc')
        .update('projectMode', true, vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand('vscode.openWith', target, 'arxmlSwc.tableView');
    }),

    vscode.commands.registerCommand('arxmlSwc.refresh', async () => {
      const active = vscode.window.activeTextEditor;
      if (active) {
        await vscode.commands.executeCommand('vscode.openWith', active.document.uri, 'arxmlSwc.tableView');
      }
    }),

    vscode.commands.registerCommand('arxmlSwc.exportCsv', async (uri?: vscode.Uri) => {
      const target = resolveUri(uri, true);
      if (!target) return;
      try {
        const text = await fs.promises.readFile(target.fsPath, 'utf8');
        const doc = parseArxml(text, target.fsPath);
        const vm = buildViewModel(doc);
        const out = await vscode.window.showSaveDialog({
          filters: { CSV: ['csv'] },
          defaultUri: vscode.Uri.file(target.fsPath.replace(/\.arxml$/i, '.csv')),
        });
        if (!out) return;
        await fs.promises.writeFile(out.fsPath, '\ufeff' + toCsv(vm), 'utf8');
        vscode.window.showInformationMessage(
          `Exported ${vm.connections.length} connections to ${out.fsPath}`
        );
      } catch (e) {
        vscode.window.showErrorMessage(`Export failed: ${(e as Error).message}`);
      }
    })
  );
}

export function deactivate() {
  /* nothing to clean up */
}

/** Picks the URI from a context-menu argument, else the active editor. */
function resolveUri(uri?: vscode.Uri, allowFilePicker = false): vscode.Uri | undefined {
  if (uri) return uri;
  const active = vscode.window.activeTextEditor;
  if (active && /\.arxml$/i.test(active.document.fileName)) return active.document.uri;
  void allowFilePicker;
  return undefined;
}
