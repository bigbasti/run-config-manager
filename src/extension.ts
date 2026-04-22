import * as vscode from 'vscode';
import { ConfigStore } from './services/ConfigStore';
import { RunConfigService } from './services/RunConfigService';
import { ProjectScanner } from './services/ProjectScanner';
import { ExecutionService } from './services/ExecutionService';
import { DebugService } from './services/DebugService';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { NpmAdapter } from './adapters/npm/NpmAdapter';
import { SpringBootAdapter } from './adapters/spring-boot/SpringBootAdapter';
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
  registry.register(new SpringBootAdapter());

  const store = new ConfigStore();
  const svc = new RunConfigService(store);
  const scanner = new ProjectScanner(registry);
  const exec = new ExecutionService(registry);
  const dbg = new DebugService(registry, exec);

  const folders = vscode.workspace.workspaceFolders ?? [];
  await store.attach(folders);

  const tree = new RunConfigTreeProvider(store, svc, exec, dbg, registry);
  const view = vscode.window.createTreeView('runConfigurations', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });

  const updateMessage = () => {
    view.message = svc.list().length === 0 ? 'No run configurations. Click + to add one.' : undefined;
  };
  updateMessage();
  store.onChange(updateMessage);

  // Badge on the Activity Bar icon showing how many configs are currently running.
  const updateBadge = () => {
    const running = svc.list().filter(r => r.valid && (exec.isRunning(r.config.id) || dbg.isRunning(r.config.id)));
    if (running.length > 0) {
      view.badge = { value: running.length, tooltip: `${running.length} running configuration${running.length === 1 ? '' : 's'}` };
    } else {
      view.badge = undefined;
    }
  };
  updateBadge();
  exec.onRunningChanged(updateBadge);
  dbg.onRunningChanged(updateBadge);
  store.onChange(updateBadge);

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

    vscode.commands.registerCommand('runConfig.edit', async (arg: ConfigNodeArg) => {
      if (!arg) return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;

      if (arg.kind === 'config') {
        const adapter = registry.get(arg.config.type);
        if (!adapter) return;
        const detectionContext = await buildEditContext(adapter, folder, arg.config.projectPath);
        EditorPanel.open({
          mode: 'edit',
          folderKey: arg.folderKey,
          folder,
          existing: arg.config,
          schema: adapter.getFormSchema(detectionContext),
        }, context, svc);
      } else {
        const recovered = buildRecoveredConfig(arg.entry);
        const type: RunConfigType = (recovered.type as RunConfigType) ?? 'npm';
        const adapter = registry.get(type);
        if (!adapter) return;
        const detectionContext = await buildEditContext(adapter, folder, recovered.projectPath ?? '');
        EditorPanel.open({
          mode: 'edit',
          folderKey: arg.folderKey,
          folder,
          existing: recovered as RunConfig,
          schema: adapter.getFormSchema(detectionContext),
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
      // A single config can be either in a run task OR a debug session.
      // Stop whichever is actually tracking it.
      if (dbg.isRunning(arg.config.id)) {
        await dbg.stop(arg.config.id);
      } else {
        await exec.stop(arg.config.id);
      }
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

      const recovered = buildRecoveredConfig(arg.entry);
      const type: RunConfigType = (recovered.type as RunConfigType) ?? 'npm';
      const adapter = registry.get(type);
      if (!adapter) return;

      const projectUri = recovered.projectPath
        ? vscode.Uri.joinPath(folder.uri, recovered.projectPath)
        : folder.uri;

      let detection: Awaited<ReturnType<typeof adapter.detect>> = null;
      try {
        detection = await adapter.detect(projectUri);
      } catch { /* ignore — best-effort */ }

      // Merge adapter defaults under recovered data. Adapters produce a
      // correctly-shaped typeOptions for their type, and recovered may carry
      // a subset — merging at this level is shape-correct regardless of type.
      const defaults = (detection?.defaults ?? {}) as Record<string, unknown>;
      const recoveredAny = recovered as Record<string, unknown>;
      const merged: Record<string, unknown> = {
        ...defaults,
        ...recoveredAny,
        typeOptions: {
          ...((defaults.typeOptions as object) ?? {}),
          ...((recoveredAny.typeOptions as object) ?? {}),
        },
      };

      EditorPanel.open({
        mode: 'edit',
        folderKey: arg.folderKey,
        folder,
        existing: merged as unknown as RunConfig,
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

  const adapter = registry.get(typePick.value)!;

  const relProject = projectUri.fsPath.startsWith(folder.uri.fsPath)
    ? projectUri.fsPath.slice(folder.uri.fsPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : projectUri.fsPath;

  // When the adapter supports streaming detection, open the editor immediately
  // with an empty schema and let it fill in as each probe completes.
  if (adapter.detectStreaming) {
    const seedDefaults = {
      type: typePick.value,
      projectPath: relProject,
      workspaceFolder: folder.name,
    };
    const schema = adapter.getFormSchema({});
    EditorPanel.open({
      mode: 'create',
      folderKey: folder.uri.fsPath,
      folder,
      seedDefaults: seedDefaults as Partial<RunConfig>,
      schema,
      streaming: {
        adapter,
        initialContext: {},
        // Fields that have their options populated by detection — the webview
        // shows spinners in these fields until schemaUpdate messages arrive.
        pending: [
          'typeOptions.mainClass',
          'typeOptions.jdkPath',
          'typeOptions.classpath',
          'typeOptions.profiles',
          'typeOptions.gradleCommand',
          'typeOptions.gradlePath',
          'typeOptions.mavenPath',
          'typeOptions.buildRoot',
        ],
      },
    }, context, svc);
    return;
  }

  // Non-streaming adapters: keep the legacy block-on-detect path.
  const detection = await scanner.scan(projectUri, typePick.value);
  if (!detection) {
    vscode.window.showWarningMessage(`No ${typePick.label} project detected — proceeding with blank form.`);
  }
  const schema = adapter.getFormSchema(detection?.context ?? {});
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

async function buildEditContext(
  adapter: { detect: (uri: vscode.Uri) => Promise<{ context: Record<string, unknown> } | null> },
  folder: vscode.WorkspaceFolder,
  projectPath: string,
): Promise<Record<string, unknown>> {
  const projectUri = projectPath
    ? vscode.Uri.joinPath(folder.uri, projectPath)
    : folder.uri;
  try {
    const detection = await adapter.detect(projectUri);
    return detection?.context ?? {};
  } catch {
    return {};
  }
}

export function deactivate(): void {
  log.info('Run Configurations deactivating.');
}
