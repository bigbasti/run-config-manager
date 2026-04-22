import * as vscode from 'vscode';
import { ConfigStore } from './services/ConfigStore';
import { RunConfigService } from './services/RunConfigService';
import { ProjectScanner } from './services/ProjectScanner';
import { ExecutionService } from './services/ExecutionService';
import { DebugService } from './services/DebugService';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { NpmAdapter } from './adapters/npm/NpmAdapter';
import { SpringBootAdapter } from './adapters/spring-boot/SpringBootAdapter';
import { TomcatAdapter } from './adapters/tomcat/TomcatAdapter';
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
  registry.register(new TomcatAdapter());

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

  // Badge on the Activity Bar icon + context key for the "Stop All" title-bar
  // button's when-clause. Both derive from the same running-configs count, so
  // we compute once and fan out.
  const updateRunningState = () => {
    const running = svc.list().filter(r =>
      r.valid && (exec.isRunning(r.config.id) || exec.isPreparing(r.config.id) || dbg.isRunning(r.config.id)),
    );
    if (running.length > 0) {
      view.badge = { value: running.length, tooltip: `${running.length} running configuration${running.length === 1 ? '' : 's'}` };
    } else {
      view.badge = undefined;
    }
    void vscode.commands.executeCommand('setContext', 'rcm.anyRunning', running.length > 0);
  };
  updateRunningState();
  exec.onRunningChanged(updateRunningState);
  dbg.onRunningChanged(updateRunningState);
  store.onChange(updateRunningState);

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

    vscode.commands.registerCommand('runConfig.stopAll', async () => {
      const running = svc.list().filter(r =>
        r.valid && (exec.isRunning(r.config.id) || dbg.isRunning(r.config.id)),
      );
      if (running.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `Stop ${running.length} running configuration${running.length === 1 ? '' : 's'}?`,
        { modal: true },
        'Stop All',
      );
      if (confirm !== 'Stop All') return;
      // Fire every stop in parallel — they're independent and each may have
      // to wait for a SIGTERM→SIGKILL grace period.
      await Promise.all(running.map(async r => {
        if (dbg.isRunning(r.config.id)) await dbg.stop(r.config.id);
        if (exec.isRunning(r.config.id)) await exec.stop(r.config.id);
      }));
    }),

    vscode.commands.registerCommand('runConfig.autoCreate', async () => {
      await autoCreateConfigs(store, svc, registry);
    }),

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
          // Spring Boot
          'typeOptions.mainClass',
          'typeOptions.classpath',
          'typeOptions.profiles',
          'typeOptions.gradleCommand',
          'typeOptions.buildRoot',
          // Shared Java
          'typeOptions.jdkPath',
          'typeOptions.gradlePath',
          'typeOptions.mavenPath',
          // Tomcat-specific
          'typeOptions.tomcatHome',
          'typeOptions.artifactPath',
          'typeOptions.artifactKind',
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

// Scan every direct child of the chosen folder and ask each adapter if it
// recognises the module. For each match, create a config with the adapter's
// detected defaults. Higher-priority types (spring-boot, tomcat) win over
// npm, which matches any folder with a package.json — including pure-tooling
// folders in Java projects. We skip modules that already have a config of
// the same type in the same folder-key so the user can run this repeatedly
// without duplicates.
async function autoCreateConfigs(
  store: ConfigStore,
  svc: RunConfigService,
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

  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: folder.uri,
    openLabel: 'Scan this directory for modules',
  });
  if (!picked || picked.length === 0) return;
  const root = picked[0];

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Auto-creating run configurations…', cancellable: false },
    async (progress) => {
      // Priority: spring-boot beats tomcat beats npm. Any project with both
      // Spring Boot and a WAR output could match tomcat too; we pick the
      // more specific one. npm is the catch-all — lots of Java projects have
      // package.json for lint/docs tooling.
      const priority: RunConfigType[] = ['spring-boot', 'tomcat', 'npm'];

      const children = await listDirectChildren(root);
      // Also scan the root itself as a candidate module (single-module repos).
      const candidates: vscode.Uri[] = [root, ...children];

      const existing = new Set<string>();
      for (const c of svc.list()) {
        if (c.valid) {
          existing.add(`${c.folderKey}|${c.config.type}|${c.config.projectPath}`);
        }
      }

      const created: string[] = [];
      const skipped: string[] = [];
      let done = 0;

      for (const child of candidates) {
        done++;
        const rel = relativePath(folder.uri.fsPath, child.fsPath);
        progress.report({ message: rel || '(workspace root)', increment: (100 / candidates.length) });

        let match: { type: RunConfigType; defaults: Partial<RunConfig> } | null = null;
        for (const type of priority) {
          const adapter = registry.get(type);
          if (!adapter) continue;
          try {
            const detection = await adapter.detect(child);
            if (detection) {
              match = { type, defaults: detection.defaults };
              break;
            }
          } catch { /* skip — adapter failed to probe */ }
        }
        if (!match) continue;

        // Skip duplicates by type+path.
        const key = `${folder!.uri.fsPath}|${match.type}|${rel}`;
        if (existing.has(key)) {
          skipped.push(`${rel || '(root)'} (${match.type}, already exists)`);
          continue;
        }

        const name = deriveConfigName(child, match.type);
        const merged = mergeAutoCreateDefaults(match.type, match.defaults, {
          name,
          projectPath: rel,
          workspaceFolder: folder!.name,
        });
        if (!merged) continue;

        try {
          await svc.create(folder!.uri.fsPath, merged);
          created.push(`${name} (${match.type})`);
          existing.add(key);
        } catch (e) {
          log.warn(`Auto-create failed for ${rel}: ${(e as Error).message}`);
        }
      }

      const lines: string[] = [];
      if (created.length) {
        lines.push(`Created ${created.length} configuration${created.length === 1 ? '' : 's'}:`);
        for (const c of created) lines.push(`  • ${c}`);
      }
      if (skipped.length) {
        lines.push(`Skipped ${skipped.length} already-existing:`);
        for (const s of skipped.slice(0, 5)) lines.push(`  • ${s}`);
        if (skipped.length > 5) lines.push(`  • …and ${skipped.length - 5} more`);
      }
      if (!created.length && !skipped.length) {
        vscode.window.showInformationMessage('Auto-create found no recognised modules under the chosen folder.');
      } else {
        vscode.window.showInformationMessage(lines.join('\n'), { modal: false });
      }
    },
  );
}

async function listDirectChildren(dir: vscode.Uri): Promise<vscode.Uri[]> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const skip = new Set([
      'node_modules', 'target', 'build', 'out', '.gradle', '.idea', '.vscode', '.git', 'dist', 'bin',
    ]);
    return entries
      .filter(([name, kind]) => kind === vscode.FileType.Directory && !name.startsWith('.') && !skip.has(name))
      .map(([name]) => vscode.Uri.joinPath(dir, name));
  } catch {
    return [];
  }
}

function relativePath(root: string, child: string): string {
  if (child === root) return '';
  if (child.startsWith(root + '/') || child.startsWith(root + '\\')) {
    return child.slice(root.length + 1).replace(/\\/g, '/');
  }
  return child;
}

function deriveConfigName(child: vscode.Uri, type: RunConfigType): string {
  const base = child.fsPath.split(/[/\\]/).filter(Boolean).pop() ?? 'app';
  const suffix = type === 'spring-boot' ? 'API' : type === 'tomcat' ? 'Tomcat' : 'Web';
  // Capitalise first letter, keep the rest as-is ("api" → "Api").
  const pretty = base.charAt(0).toUpperCase() + base.slice(1);
  return `${pretty} ${suffix}`;
}

// Produce an Omit<RunConfig,'id'> suitable for RunConfigService.create.
// Takes the adapter's detected defaults and fills in any missing required
// fields with safe literals. Returning null skips the config — only happens
// when the adapter returned null which shouldn't reach here.
function mergeAutoCreateDefaults(
  type: RunConfigType,
  defaults: Partial<RunConfig>,
  common: { name: string; projectPath: string; workspaceFolder: string },
): Omit<RunConfig, 'id'> | null {
  const typeOptions = (defaults.typeOptions ?? {}) as any;
  const base = {
    name: common.name,
    projectPath: common.projectPath,
    workspaceFolder: common.workspaceFolder,
    env: {} as Record<string, string>,
    programArgs: '',
    vmArgs: '',
  };

  if (type === 'npm') {
    return {
      ...base,
      type: 'npm',
      typeOptions: {
        scriptName: typeOptions.scriptName ?? 'start',
        packageManager: typeOptions.packageManager ?? 'npm',
      },
    };
  }
  if (type === 'spring-boot') {
    const buildTool = typeOptions.buildTool ?? 'maven';
    return {
      ...base,
      type: 'spring-boot',
      typeOptions: {
        launchMode: typeOptions.launchMode ?? buildTool,
        buildTool,
        gradleCommand: typeOptions.gradleCommand ?? './gradlew',
        profiles: '',
        mainClass: typeOptions.mainClass ?? '',
        classpath: typeOptions.classpath ?? '',
        jdkPath: typeOptions.jdkPath ?? '',
        module: '',
        gradlePath: typeOptions.gradlePath ?? '',
        mavenPath: typeOptions.mavenPath ?? '',
        buildRoot: typeOptions.buildRoot ?? '',
      },
    };
  }
  if (type === 'tomcat') {
    return {
      ...base,
      type: 'tomcat',
      typeOptions: {
        tomcatHome: typeOptions.tomcatHome ?? '',
        jdkPath: typeOptions.jdkPath ?? '',
        httpPort: typeOptions.httpPort ?? 8080,
        buildProjectPath: '',
        buildRoot: typeOptions.buildRoot ?? '',
        buildTool: typeOptions.buildTool ?? 'gradle',
        gradleCommand: typeOptions.gradleCommand ?? './gradlew',
        gradlePath: typeOptions.gradlePath ?? '',
        mavenPath: typeOptions.mavenPath ?? '',
        artifactPath: typeOptions.artifactPath ?? '',
        artifactKind: typeOptions.artifactKind ?? 'war',
        applicationContext: '/',
        vmOptions: '',
        reloadable: true,
        rebuildOnSave: false,
      },
    };
  }
  return null;
}

export function deactivate(): void {
  log.info('Run Configurations deactivating.');
}
