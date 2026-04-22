import * as vscode from 'vscode';
import { ConfigStore } from './services/ConfigStore';
import { RunConfigService } from './services/RunConfigService';
import { ProjectScanner } from './services/ProjectScanner';
import { ExecutionService } from './services/ExecutionService';
import { DebugService } from './services/DebugService';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { NpmAdapter } from './adapters/npm/NpmAdapter';
import { RunConfigTreeProvider } from './ui/RunConfigTreeProvider';
import { EditorPanel } from './ui/EditorPanel';
import { log, initLogger } from './utils/logger';
import type { RunConfig, RunConfigType } from './shared/types';
import type { InvalidConfigEntry } from './shared/types';
import { buildRecoveredConfig } from './recovery/buildRecoveredConfig';

type ConfigNodeArg =
  | { kind: 'config'; folderKey: string; config: RunConfig }
  | { kind: 'invalid'; folderKey: string; entry: InvalidConfigEntry };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger();
  log.info('Run Configurations activating…');

  const registry = new AdapterRegistry();
  registry.register(new NpmAdapter());

  const store = new ConfigStore();
  const svc = new RunConfigService(store);
  const scanner = new ProjectScanner(registry);
  const exec = new ExecutionService(registry);
  const dbg = new DebugService(registry);

  const folders = vscode.workspace.workspaceFolders ?? [];
  await store.attach(folders);

  const tree = new RunConfigTreeProvider(store, svc, exec, dbg);
  const view = vscode.window.createTreeView('runConfigurations', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const updateMessage = () => {
    view.message = svc.list().length === 0 ? 'No run configurations. Click + to add one.' : undefined;
  };
  updateMessage();
  store.onChange(updateMessage);

  // Keep store in sync when workspace folders change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async e => {
      for (const added of e.added) await (store as any).attachFolder(added);
      // Detaching removed folders is nice-to-have; left as a known limitation for v1.
      updateMessage();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('runConfig.refresh', () => tree.refresh()),

    vscode.commands.registerCommand('runConfig.add', async () => {
      await addConfig(context, store, svc, scanner, registry);
    }),

    vscode.commands.registerCommand('runConfig.edit', (arg: ConfigNodeArg) => {
      if (!arg) return;
      const adapter = registry.get('npm'); // v1: only npm
      if (!adapter) return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;

      if (arg.kind === 'config') {
        EditorPanel.open({
          mode: 'edit',
          folderKey: arg.folderKey,
          folder,
          existing: arg.config,
          schema: adapter.getFormSchema({}),
        }, context, svc);
      } else {
        const recovered = buildRecoveredConfig(arg.entry);
        EditorPanel.open({
          mode: 'edit',
          folderKey: arg.folderKey,
          folder,
          existing: recovered as RunConfig,
          schema: adapter.getFormSchema({}),
        }, context, svc);
      }
    }),

    vscode.commands.registerCommand('runConfig.delete', async (arg: ConfigNodeArg) => {
      if (!arg) return;
      const name = arg.kind === 'config' ? arg.config.name : arg.entry.name;
      const id = arg.kind === 'config' ? arg.config.id : arg.entry.id;
      const confirm = await vscode.window.showWarningMessage(
        `Delete run configuration "${name}"?`,
        { modal: true },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      await svc.delete(arg.folderKey, id);
    }),

    vscode.commands.registerCommand('runConfig.run', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      await exec.run(arg.config, folder);
    }),

    vscode.commands.registerCommand('runConfig.stop', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      await exec.stop(arg.config.id);
    }),

    vscode.commands.registerCommand('runConfig.debug', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      await dbg.debug(arg.config, folder);
    }),

    vscode.commands.registerCommand('runConfig.fix', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'invalid') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      const adapter = registry.get('npm');
      if (!adapter) return;

      const recovered = buildRecoveredConfig(arg.entry);
      const projectUri = recovered.projectPath
        ? vscode.Uri.joinPath(folder.uri, recovered.projectPath)
        : folder.uri;

      let detection: Awaited<ReturnType<typeof adapter.detect>> = null;
      try {
        detection = await adapter.detect(projectUri);
      } catch { /* ignore — best-effort */ }

      const defaults = detection?.defaults ?? {};
      const merged: Partial<RunConfig> = {
        ...defaults,
        ...recovered,
        typeOptions: {
          scriptName: recovered.typeOptions?.scriptName ?? defaults.typeOptions?.scriptName ?? '',
          packageManager:
            (recovered.typeOptions?.packageManager ?? defaults.typeOptions?.packageManager ?? 'npm') as 'npm' | 'yarn' | 'pnpm',
        },
      };

      EditorPanel.open({
        mode: 'edit',
        folderKey: arg.folderKey,
        folder,
        existing: merged as RunConfig,
        schema: adapter.getFormSchema(detection?.context ?? {}),
      }, context, svc);
    }),

    vscode.commands.registerCommand('runConfig.openFile', async (arg: ConfigNodeArg) => {
      if (!arg) return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'run.json');
      await vscode.commands.executeCommand('vscode.open', uri);
    }),

    view,
    { dispose: () => store.dispose() },
    { dispose: () => exec.dispose() },
    { dispose: () => dbg.dispose() },
    { dispose: () => log.dispose() },
  );

  log.info('Run Configurations ready.');
}

async function addConfig(
  context: vscode.ExtensionContext,
  store: ConfigStore,
  svc: RunConfigService,
  scanner: ProjectScanner,
  registry: AdapterRegistry,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    vscode.window.showErrorMessage('Open a workspace folder first.');
    return;
  }

  let folder: vscode.WorkspaceFolder | undefined;
  if (folders.length === 1) folder = folders[0];
  else folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Workspace folder' });
  if (!folder) return;

  const projectFolderUris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: folder.uri,
    openLabel: 'Use this as project root',
  });
  if (!projectFolderUris || projectFolderUris.length === 0) return;
  const projectUri = projectFolderUris[0];

  const typePick = await vscode.window.showQuickPick(
    registry.all().map(a => ({ label: a.label, value: a.type as RunConfigType })),
    { placeHolder: 'Run configuration type' },
  );
  if (!typePick) return;

  const detection = await scanner.scan(projectUri, typePick.value);
  if (!detection) {
    vscode.window.showWarningMessage(`No ${typePick.label} project detected — proceeding with blank form.`);
  }

  const adapter = registry.get(typePick.value)!;
  const schema = adapter.getFormSchema(detection?.context ?? {});

  const relProject = projectUri.fsPath.startsWith(folder.uri.fsPath)
    ? projectUri.fsPath.slice(folder.uri.fsPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : projectUri.fsPath;

  const seedDefaults = {
    ...(detection?.defaults ?? {}),
    projectPath: relProject,
    workspaceFolder: folder.name,
  };

  EditorPanel.open({
    mode: 'create',
    folderKey: folder.uri.fsPath,
    folder,
    seedDefaults,
    schema,
  }, context, svc);
}

export function deactivate(): void {
  log.info('Run Configurations deactivating.');
}
