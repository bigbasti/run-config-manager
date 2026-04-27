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
import { QuarkusAdapter } from './adapters/quarkus/QuarkusAdapter';
import { JavaAdapter } from './adapters/java/JavaAdapter';
import { MavenGoalAdapter } from './adapters/maven-goal/MavenGoalAdapter';
import { GradleTaskAdapter } from './adapters/gradle-task/GradleTaskAdapter';
import { CustomCommandAdapter } from './adapters/custom-command/CustomCommandAdapter';
import { DockerAdapter } from './adapters/docker/DockerAdapter';
import { DockerService } from './services/DockerService';
import { RunConfigTreeProvider } from './ui/RunConfigTreeProvider';
import { NativeRunnerTreeProvider } from './ui/NativeRunnerTreeProvider';
import { EditorPanel } from './ui/EditorPanel';
import { NativeRunnerService, type NativeLaunch, type NativeTask } from './services/NativeRunnerService';
import { buildDependencyOptions, rcmRef } from './services/dependencyCandidates';
import { DependencyOrchestrator } from './services/DependencyOrchestrator';
import { resolveBuildContext, buildCommandFor, buildActionLabel } from './services/buildActions';
import {
  NativeLaunchContentProvider,
  SCHEME as NATIVE_VIEW_SCHEME,
  launchViewUri,
  taskViewUri,
} from './ui/NativeLaunchContentProvider';
import { log, initLogger } from './utils/logger';
import type { RunConfig, RunConfigType } from './shared/types';
import type { InvalidConfigEntry } from './shared/types';
import { buildRecoveredConfig } from './recovery/buildRecoveredConfig';
import { RunConfigSchema } from './shared/schema';

type ConfigNodeArg =
  | { kind: 'config'; folderKey: string; config: RunConfig }
  | { kind: 'invalid'; folderKey: string; entry: InvalidConfigEntry };

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  initLogger();
  log.info('Run Configurations activating…');

  const docker = new DockerService();
  docker.start();
  context.subscriptions.push({ dispose: () => docker.dispose() });

  const registry = new AdapterRegistry();
  registry.register(new NpmAdapter());
  registry.register(new SpringBootAdapter());
  registry.register(new TomcatAdapter());
  registry.register(new QuarkusAdapter());
  registry.register(new JavaAdapter());
  registry.register(new MavenGoalAdapter());
  registry.register(new GradleTaskAdapter());
  registry.register(new CustomCommandAdapter());
  registry.register(new DockerAdapter(docker));
  log.debug(`Registered adapters: ${registry.all().map(a => a.type).join(', ')}`);

  const store = new ConfigStore();
  const svc = new RunConfigService(store);
  const scanner = new ProjectScanner(registry);
  const exec = new ExecutionService(registry);
  const dbg = new DebugService(registry, exec);
  const native = new NativeRunnerService();
  context.subscriptions.push({ dispose: () => native.dispose() });

  const folders = vscode.workspace.workspaceFolders ?? [];
  log.debug(`Workspace folders: ${folders.length ? folders.map(f => f.uri.fsPath).join(', ') : '(none)'}`);
  await store.attach(folders);
  log.info(`Loaded ${svc.list().length} configuration(s) across ${folders.length} folder(s).`);

  const orchestrator = new DependencyOrchestrator(svc, exec, dbg, docker, native);
  const tree = new RunConfigTreeProvider(store, svc, exec, dbg, registry, context.extensionUri, docker, orchestrator, native);
  // Separate view for native launch.json / tasks.json — sibling to the
  // main Configurations view, like VARIABLES / BREAKPOINTS in Run & Debug.
  const nativeTree = new NativeRunnerTreeProvider(native);
  // Read-only virtual document provider for "view launch/task JSON" clicks.
  const nativeContent = new NativeLaunchContentProvider(native);
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(NATIVE_VIEW_SCHEME, nativeContent),
  );
  const view = vscode.window.createTreeView('runConfigurations', {
    treeDataProvider: tree,
    showCollapseAll: true,
  });
  const launchTasksView = vscode.window.createTreeView('runConfigLaunchTasks', {
    treeDataProvider: nativeTree,
    showCollapseAll: true,
  });
  context.subscriptions.push(launchTasksView);

  const updateMessage = () => {
    view.message = svc.list().length === 0 ? 'No run configurations. Click + to add one.' : undefined;
  };
  updateMessage();
  store.onChange(updateMessage);

  // Badge on the Activity Bar icon + context key for the "Stop All" title-bar
  // button's when-clause. Both derive from the same running-configs count, so
  // we compute once and fan out.
  const updateRunningState = () => {
    const running = svc.list().filter(r => {
      if (!r.valid) return false;
      if (r.config.type === 'docker') {
        return docker.isRunning(r.config.typeOptions.containerId);
      }
      return exec.isRunning(r.config.id) || exec.isPreparing(r.config.id) || dbg.isRunning(r.config.id);
    });
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
  docker.onChanged(updateRunningState);

  // Keep store in sync when workspace folders change.
  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(async e => {
      for (const added of e.added) await (store as any).attachFolder(added);
      // Detaching removed folders is nice-to-have; left as a known limitation for v1.
      updateMessage();
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('runConfig.refresh', () => {
      log.debug('Command: refresh');
      tree.refresh();
      // Also invalidate the launch/tasks cache so a fresh fetchTasks runs.
      nativeTree.invalidate();
    }),

    vscode.commands.registerCommand('runConfig.reveal', (arg: ConfigNodeArg) => {
      // Click target for a running config row — bring the task's integrated
      // terminal into view. No-op if the config isn't actually running (e.g.,
      // state updated between click and dispatch).
      if (!arg || arg.kind !== 'config') return;
      log.info(`Reveal terminal: "${arg.config.name}"`);
      if (dbg.isRunning(arg.config.id)) {
        // Debug sessions don't own an integrated terminal by default; fall
        // back to revealing the task terminal if one exists, else focus the
        // debug console.
        exec.focus(arg.config.id);
        return;
      }
      if (exec.isRunning(arg.config.id)) {
        exec.focus(arg.config.id);
      }
    }),

    vscode.commands.registerCommand('runConfig.clone', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      const suggested = `${arg.config.name} (copy)`;
      const newName = await vscode.window.showInputBox({
        title: 'Clone run configuration',
        prompt: `Clone "${arg.config.name}"`,
        value: suggested,
        valueSelection: [0, suggested.length],
        validateInput: v => v.trim() ? null : 'Name is required',
      });
      if (!newName) return;

      // Deep-clone via JSON so nested typeOptions/env are independent from
      // the source config. Strip id — RunConfigService.create issues a new
      // one.
      const clone = JSON.parse(JSON.stringify(arg.config)) as RunConfig;
      const { id: _id, ...rest } = clone;
      const created = { ...rest, name: newName.trim() } as Omit<RunConfig, 'id'>;
      try {
        await svc.create(arg.folderKey, created);
        log.info(`Cloned "${arg.config.name}" → "${newName.trim()}"`);
      } catch (e) {
        log.error(`Clone failed for "${arg.config.name}"`, e);
        vscode.window.showErrorMessage(`Clone failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('runConfig.stopAll', async () => {
      const running = svc.list().filter(r => {
        if (!r.valid) return false;
        if (r.config.type === 'docker') return docker.isRunning(r.config.typeOptions.containerId);
        return exec.isRunning(r.config.id) || dbg.isRunning(r.config.id);
      });
      if (running.length === 0) return;
      const confirm = await vscode.window.showWarningMessage(
        `Stop ${running.length} running configuration${running.length === 1 ? '' : 's'}?`,
        { modal: true },
        'Stop All',
      );
      if (confirm !== 'Stop All') return;
      log.info(`Stop All: terminating ${running.length} configuration(s).`);
      // Fire every stop in parallel — they're independent and each may have
      // to wait for a SIGTERM→SIGKILL grace period.
      await Promise.all(running.map(async r => {
        if (r.valid && r.config.type === 'docker') {
          try { await docker.stopContainer(r.config.typeOptions.containerId); }
          catch (e) { log.warn(`docker stop (${r.config.name}) failed: ${(e as Error).message}`); }
          return;
        }
        if (dbg.isRunning(r.config.id)) await dbg.stop(r.config.id);
        if (exec.isRunning(r.config.id)) await exec.stop(r.config.id);
      }));
    }),

    vscode.commands.registerCommand('runConfig.autoCreate', async () => {
      log.info('Command: auto-create configurations');
      await autoCreateConfigs(store, svc, registry);
    }),

    vscode.commands.registerCommand('runConfig.add', async () => {
      log.info('Command: add configuration');
      await addConfig(context, store, svc, scanner, registry, docker, native);
    }),

    vscode.commands.registerCommand('runConfig.edit', async (arg: ConfigNodeArg) => {
      if (!arg) return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;

      if (arg.kind === 'config') {
        log.info(`Edit: "${arg.config.name}" (${arg.config.type})`);
        const adapter = registry.get(arg.config.type);
        if (!adapter) return;
        const detectionContext = await buildEditContext(adapter, folder, arg.config.projectPath);
        const dependencyOptions = await gatherDependencyOptions(svc, native, arg.folderKey, arg.config.id);
        EditorPanel.open({
          mode: 'edit',
          folderKey: arg.folderKey,
          folder,
          adapter,
          existing: arg.config,
          schema: adapter.getFormSchema({ ...detectionContext, dependencyOptions }),
          docker,
          dependencyOptions,
        }, context, svc);
      } else {
        log.info(`Edit invalid entry: "${arg.entry.name}"`);
        const recovered = buildRecoveredConfig(arg.entry);
        const type: RunConfigType = (recovered.type as RunConfigType) ?? 'npm';
        const adapter = registry.get(type);
        if (!adapter) return;
        const detectionContext = await buildEditContext(adapter, folder, recovered.projectPath ?? '');
        const dependencyOptions = await gatherDependencyOptions(svc, native, arg.folderKey, arg.entry.id);
        EditorPanel.open({
          mode: 'edit',
          folderKey: arg.folderKey,
          folder,
          adapter,
          existing: recovered as RunConfig,
          schema: adapter.getFormSchema({ ...detectionContext, dependencyOptions }),
          docker,
          dependencyOptions,
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
      log.info(`Delete: "${name}"`);
      await svc.delete(arg.folderKey, id);
    }),

    vscode.commands.registerCommand('runConfig.run', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      log.info(`Run: "${arg.config.name}" (${arg.config.type})`);

      // When the config has dependencies, fan out through the orchestrator.
      // It starts each dep in order, waits for running-state, applies the
      // per-edge delay, then starts the root. The tree expands / collapses
      // automatically — the provider flips the root and nested depRcm nodes
      // to Expanded while an orchestration snapshot is active, then back to
      // Collapsed when it clears ~1.5s after the root reports running.
      if ((arg.config.dependsOn?.length ?? 0) > 0) {
        await orchestrator.run(arg.config, folder);
        return;
      }

      if (arg.config.type === 'docker') {
        // Docker bypasses ExecutionService entirely — start/stop are
        // one-shot daemon calls and the "running" state comes from polling.
        try {
          await docker.startContainer(arg.config.typeOptions.containerId);
        } catch (e) {
          vscode.window.showErrorMessage(`docker start failed: ${(e as Error).message}`);
        }
        return;
      }
      await exec.run(arg.config, folder);
    }),

    vscode.commands.registerCommand('runConfig.stop', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      log.info(`Stop: "${arg.config.name}"`);
      if (arg.config.type === 'docker') {
        try {
          await docker.stopContainer(arg.config.typeOptions.containerId);
        } catch (e) {
          vscode.window.showErrorMessage(`docker stop failed: ${(e as Error).message}`);
        }
        return;
      }
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
      log.info(`Debug: "${arg.config.name}" (${arg.config.type})`);
      await dbg.debug(arg.config, folder);
    }),

    vscode.commands.registerCommand('runConfig.fix', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'invalid') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      log.info(`Fix invalid: "${arg.entry.name}"`);

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

      // Run the reconstructed config through Zod so the editor can
      // highlight the specific fields that made this entry invalid. The
      // entry's stored `error` is also surfaced via the tree tooltip, but
      // per-field feedback inside the form is what actually guides the fix.
      const initialFieldErrors = collectFieldErrors(merged);
      const dependencyOptions = await gatherDependencyOptions(svc, native, arg.folderKey, merged.id as string | undefined);
      EditorPanel.open({
        mode: 'edit',
        folderKey: arg.folderKey,
        folder,
        adapter,
        existing: merged as unknown as RunConfig,
        schema: adapter.getFormSchema({ ...(detection?.context ?? {}), dependencyOptions }),
        initialFieldErrors,
        docker,
        dependencyOptions,
      }, context, svc);
    }),

    vscode.commands.registerCommand('runConfig.openFile', async (arg: ConfigNodeArg) => {
      if (!arg) return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'run.json');
      log.info(`Open file: ${uri.fsPath}`);
      await vscode.commands.executeCommand('vscode.open', uri);
    }),

    // --- Launch & Tasks section (bridges .vscode/launch.json + tasks.json) ---

    vscode.commands.registerCommand('runConfig.viewNativeLaunch', async (arg: any) => {
      const launch: NativeLaunch | undefined = arg?.launch;
      if (!launch) return;
      const uri = launchViewUri(launch.folderKey, launch.name);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('runConfig.viewNativeTask', async (arg: any) => {
      const task: NativeTask | undefined = arg?.task;
      if (!task) return;
      const uri = taskViewUri(task.folderKey, task.source, task.name);
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true });
    }),
    vscode.commands.registerCommand('runConfig.runNativeLaunch', async (arg: any) => {
      const launch: NativeLaunch | undefined = arg?.launch;
      if (!launch) return;
      await native.runLaunch(launch);
    }),
    vscode.commands.registerCommand('runConfig.stopNativeLaunch', async (arg: any) => {
      const launch: NativeLaunch | undefined = arg?.launch;
      if (!launch) return;
      await native.stopLaunch(launch.name);
    }),
    vscode.commands.registerCommand('runConfig.runNativeTask', async (arg: any) => {
      // Args can come from either a nativeTask node (has .task) or a
      // nativeLaunchDepTask node (has .parentLaunch + .taskName + .folderKey).
      if (arg?.task) {
        await native.runTask(arg.task as NativeTask);
        return;
      }
      if (arg?.taskName && arg?.folderKey) {
        const list = await native.getTasks();
        const found = list.find(t => t.folderKey === arg.folderKey && t.name === arg.taskName);
        if (!found) {
          vscode.window.showWarningMessage(`Task "${arg.taskName}" not found.`);
          return;
        }
        await native.runTask(found);
      }
    }),
    vscode.commands.registerCommand('runConfig.stopNativeTask', async (arg: any) => {
      if (arg?.task) {
        await native.stopTask(arg.task.source, arg.task.name);
        return;
      }
      if (arg?.taskName && arg?.folderKey) {
        const list = await native.getTasks();
        const found = list.find(t => t.folderKey === arg.folderKey && t.name === arg.taskName);
        if (found) await native.stopTask(found.source, found.name);
      }
    }),
    vscode.commands.registerCommand('runConfig.editNativeLaunch', async (arg: any) => {
      const launch: NativeLaunch | undefined = arg?.launch;
      if (!launch) return;
      const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === launch.folderKey);
      if (!folder) return;
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');
      await vscode.commands.executeCommand('vscode.open', uri);
    }),
    vscode.commands.registerCommand('runConfig.editNativeTask', async (arg: any) => {
      const task: NativeTask | undefined = arg?.task;
      if (!task) return;
      const folder = vscode.workspace.workspaceFolders?.find(f => f.uri.fsPath === task.folderKey);
      if (!folder) return;
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'tasks.json');
      await vscode.commands.executeCommand('vscode.open', uri);
    }),

    // --- Docker commands ---

    vscode.commands.registerCommand('runConfig.viewDockerLogs', (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config' || arg.config.type !== 'docker') return;
      const to = arg.config.typeOptions;
      if (!to.containerId) {
        vscode.window.showWarningMessage(
          `"${arg.config.name}" has no container selected — edit it first.`,
        );
        return;
      }
      if (docker.isAvailable() === false) {
        vscode.window.showErrorMessage(
          `Docker daemon unreachable. Start Docker Desktop / dockerd and try again.`,
        );
        return;
      }
      log.info(`Show docker logs: "${arg.config.name}"`);
      docker.showLogs(to.containerId, arg.config.name);
    }),

    // --- Build-action shortcuts (Maven/Gradle clean/build/test) ---

    // Individual commands per (tool × action) so each can carry the right
    // brand icon in the right-click menu. They all funnel into the same
    // internal runner which is type-agnostic — the tool is resolved from
    // the config itself at invocation time.
    vscode.commands.registerCommand('runConfig.buildAction.maven.clean', (arg: ConfigNodeArg) => runBuildActionFor(arg, 'clean', store, svc)),
    vscode.commands.registerCommand('runConfig.buildAction.maven.build', (arg: ConfigNodeArg) => runBuildActionFor(arg, 'build', store, svc)),
    vscode.commands.registerCommand('runConfig.buildAction.maven.test',  (arg: ConfigNodeArg) => runBuildActionFor(arg, 'test',  store, svc)),
    vscode.commands.registerCommand('runConfig.buildAction.gradle.clean', (arg: ConfigNodeArg) => runBuildActionFor(arg, 'clean', store, svc)),
    vscode.commands.registerCommand('runConfig.buildAction.gradle.build', (arg: ConfigNodeArg) => runBuildActionFor(arg, 'build', store, svc)),
    vscode.commands.registerCommand('runConfig.buildAction.gradle.test',  (arg: ConfigNodeArg) => runBuildActionFor(arg, 'test',  store, svc)),

    // --- Cog: open run.json for the current (or picked) workspace folder ---

    vscode.commands.registerCommand('runConfig.openRunJson', async () => {
      const folders = vscode.workspace.workspaceFolders ?? [];
      if (folders.length === 0) {
        vscode.window.showErrorMessage('Open a workspace folder first.');
        return;
      }
      const folder = folders.length === 1
        ? folders[0]
        : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Which workspace folder\'s run.json?' });
      if (!folder) return;
      const uri = vscode.Uri.joinPath(folder.uri, '.vscode', 'run.json');
      // Create an empty skeleton if the file doesn't exist yet — otherwise
      // VS Code opens a "cannot open" error for a fresh workspace and the
      // user ends up more confused than if the button did nothing.
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        const skeleton = JSON.stringify({ version: 1, configurations: [] }, null, 2) + '\n';
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(skeleton));
      }
      log.info(`Open run.json: ${uri.fsPath}`);
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
  docker: DockerService,
  native: NativeRunnerService,
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
  log.info(`Add: type=${typePick.value}, projectPath=${projectUri.fsPath}, folder=${folder.name}`);

  const relProject = projectUri.fsPath.startsWith(folder.uri.fsPath)
    ? projectUri.fsPath.slice(folder.uri.fsPath.length).replace(/^[\\/]+/, '').replace(/\\/g, '/')
    : projectUri.fsPath;

  // Pre-fill the name from the selected folder's basename so the user
  // gets something reasonable without thinking. mergeBlanks semantics in
  // the webview mean typing over it is seamless.
  const defaultName = deriveDefaultName(projectUri, folder, typePick.label);

  // When the adapter supports streaming detection, open the editor immediately
  // with an empty schema and let it fill in as each probe completes.
  if (adapter.detectStreaming) {
    const seedDefaults = {
      type: typePick.value,
      name: defaultName,
      projectPath: relProject,
      workspaceFolder: folder.name,
    };
    const dependencyOptions = await gatherDependencyOptions(svc, native, folder.uri.fsPath, undefined);
    const schema = adapter.getFormSchema({ dependencyOptions });
    EditorPanel.open({
      mode: 'create',
      folderKey: folder.uri.fsPath,
      folder,
      adapter,
      seedDefaults: seedDefaults as Partial<RunConfig>,
      schema,
      dependencyOptions,
      streaming: {
        adapter,
        initialContext: { dependencyOptions },
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
          // Quarkus-specific
          'typeOptions.profile',
          // Docker
          'typeOptions.containerId',
        ],
      },
      docker,
    }, context, svc);
    return;
  }

  // Non-streaming adapters: keep the legacy block-on-detect path.
  const detection = await scanner.scan(projectUri, typePick.value);
  if (!detection) {
    vscode.window.showWarningMessage(`No ${typePick.label} project detected — proceeding with blank form.`);
  }
  const dependencyOptions = await gatherDependencyOptions(svc, native, folder.uri.fsPath, undefined);
  const schema = adapter.getFormSchema({ ...(detection?.context ?? {}), dependencyOptions });
  const seedDefaults = {
    ...(detection?.defaults ?? {}),
    name: defaultName,
    projectPath: relProject,
    workspaceFolder: folder.name,
  };
  EditorPanel.open({
    mode: 'create',
    folderKey: folder.uri.fsPath,
    folder,
    adapter,
    seedDefaults,
    schema,
    docker,
    dependencyOptions,
  }, context, svc);
}

// Builds a default config name from the picked project folder. Examples:
//   picked "/ws/api"      type "Spring Boot"   → "Api Spring Boot"
//   picked "/ws"          type "Gradle Task"   → "Ws Gradle Task"
//   picked "/ws/systest"  type "Maven Goal"    → "Systest Maven Goal"
// Exported for testing.
export function deriveDefaultName(
  projectUri: vscode.Uri,
  folder: vscode.WorkspaceFolder,
  typeLabel: string,
): string {
  const basename = projectUri.fsPath.split(/[/\\]/).filter(Boolean).pop()
    ?? folder.name
    ?? 'App';
  const pretty = basename.charAt(0).toUpperCase() + basename.slice(1);
  return `${pretty} ${typeLabel}`;
}

// Shared runner for the six build-action commands. Accepts whatever the
// right-click menu arg looks like — a `config` tree node, or a `depRcm`
// child node, or the full RunConfig when invoked programmatically.
async function runBuildActionFor(
  arg: any,
  action: 'clean' | 'build' | 'test',
  store: ConfigStore,
  svc: RunConfigService,
): Promise<void> {
  // Unwrap either a `config` tree node or a `depRcm` one.
  let folderKey: string | undefined;
  let cfg: RunConfig | undefined;
  if (arg && arg.kind === 'config') {
    folderKey = arg.folderKey;
    cfg = arg.config;
  } else if (arg && arg.kind === 'depRcm') {
    // dep-row arg: look up the containing folder by id.
    cfg = arg.config;
    const entry = svc.list().find(r => r.valid && r.config.id === cfg!.id);
    folderKey = entry?.folderKey;
  }
  if (!cfg || !folderKey) return;
  const folder = store.getFolder(folderKey);
  if (!folder) return;
  const ctx = resolveBuildContext(cfg, folder);
  if (!ctx) {
    vscode.window.showWarningMessage(
      `"${cfg.name}" has no resolved Maven/Gradle build tool — check the config's projectPath / buildRoot / buildTool.`,
    );
    return;
  }
  const taskArgs = buildCommandFor(ctx, action);
  const execution = new vscode.ShellExecution(ctx.binary, taskArgs, {
    cwd: ctx.cwd,
    env: ctx.env,
  });
  const taskName = `${cfg.name} · ${buildActionLabel(action)}`;
  const task = new vscode.Task(
    { type: 'rcm-build', configId: cfg.id, action } as any,
    folder,
    taskName,
    'Run Configurations',
    execution,
    [],
  );
  log.info(`Build action: ${taskName} (${ctx.binary} ${taskArgs.join(' ')}) cwd=${ctx.cwd}`);
  try {
    await vscode.tasks.executeTask(task);
  } catch (e) {
    vscode.window.showErrorMessage(`Build action failed to start: ${(e as Error).message}`);
  }
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

// Snapshot the "Depends on" candidates at edit-open time: other run configs
// in this folder plus workspace launches and tasks. Native tasks are fetched
// async — we wait here so the form has the full list on first paint.
async function gatherDependencyOptions(
  svc: RunConfigService,
  native: NativeRunnerService,
  folderKey: string,
  excludeId: string | undefined,
): Promise<Array<{ value: string; label: string; group: string; description?: string }>> {
  const folderConfigs = svc.list()
    .filter(r => r.valid && r.folderKey === folderKey)
    .map(r => (r as any).config as RunConfig);
  let tasks: Awaited<ReturnType<typeof native.getTasks>> = [];
  try {
    tasks = await native.getTasks();
  } catch (e) {
    log.warn(`gatherDependencyOptions: fetchTasks failed: ${(e as Error).message}`);
  }
  return buildDependencyOptions({
    folderConfigs,
    excludeId,
    launches: native.getLaunches(),
    tasks,
    folderKey,
  });
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
      // Priority: spring-boot > quarkus > tomcat > java > npm. Spring Boot
      // first because a hybrid project with both plugins should pick Spring
      // Boot; Quarkus second because it's more specific than Tomcat (which
      // matches any project that produces a WAR). Java is the Maven/Gradle
      // catch-all — its detector bails when Spring Boot / Quarkus / Tomcat
      // markers are present, so it only wins for plain Java projects. npm
      // is last — lots of Java projects have package.json for lint/docs
      // tooling.
      const priority: RunConfigType[] = ['spring-boot', 'quarkus', 'tomcat', 'java', 'npm'];

      const children = await listDirectChildren(root);
      // Also scan the root itself as a candidate module (single-module repos).
      const candidates: vscode.Uri[] = [root, ...children];
      log.debug(`Auto-create: scanning ${candidates.length} folder(s) under ${root.fsPath}`);

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
      log.info(`Auto-create: created=${created.length}, skipped=${skipped.length}`);
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
  const suffix =
    type === 'spring-boot'    ? 'API' :
    type === 'quarkus'        ? 'Quarkus' :
    type === 'tomcat'         ? 'Tomcat' :
    type === 'java'           ? 'Java' :
    type === 'custom-command' ? 'Script' :
    type === 'docker'         ? 'Container' :
                                'Web';
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
        profiles: '',
        vmOptions: '',
        reloadable: true,
        rebuildOnSave: false,
      },
    };
  }
  if (type === 'quarkus') {
    const buildTool = typeOptions.buildTool ?? 'maven';
    return {
      ...base,
      type: 'quarkus',
      typeOptions: {
        launchMode: typeOptions.launchMode ?? buildTool,
        buildTool,
        gradleCommand: typeOptions.gradleCommand ?? './gradlew',
        profile: '',
        jdkPath: typeOptions.jdkPath ?? '',
        module: '',
        gradlePath: typeOptions.gradlePath ?? '',
        mavenPath: typeOptions.mavenPath ?? '',
        buildRoot: typeOptions.buildRoot ?? '',
        debugPort: 5005,
        colorOutput: true,
      },
    };
  }
  if (type === 'java') {
    // Match detect()'s logic: fall back to java-main when no build tool was
    // detected (typeOptions.buildTool would be null/undefined in that case).
    const buildTool = typeOptions.buildTool ?? 'maven';
    const launchMode = typeOptions.launchMode ?? (typeOptions.buildTool ?? 'java-main');
    return {
      ...base,
      type: 'java',
      typeOptions: {
        launchMode,
        buildTool,
        gradleCommand: typeOptions.gradleCommand ?? './gradlew',
        mainClass: typeOptions.mainClass ?? '',
        classpath: typeOptions.classpath ?? '',
        customArgs: '',
        jdkPath: typeOptions.jdkPath ?? '',
        module: '',
        gradlePath: typeOptions.gradlePath ?? '',
        mavenPath: typeOptions.mavenPath ?? '',
        buildRoot: typeOptions.buildRoot ?? '',
        debugPort: 5005,
        colorOutput: true,
      },
    };
  }
  if (type === 'custom-command') {
    // Custom commands are user-authored by definition; auto-create never
    // reaches this branch today because 'custom-command' isn't in the
    // priority list. The case exists so the exhaustiveness guard stays
    // happy if the priority list ever expands.
    return {
      ...base,
      type: 'custom-command',
      typeOptions: {
        command: typeOptions.command ?? '',
        cwd: typeOptions.cwd ?? '',
        shell: typeOptions.shell ?? 'default',
        interactive: typeOptions.interactive ?? false,
        colorOutput: true,
      },
    };
  }
  if (type === 'docker') {
    // Docker configs are always user-initiated — there's no filesystem marker
    // that implies "this folder should have a docker container". The branch
    // exists for parity with the other types.
    return {
      ...base,
      type: 'docker',
      typeOptions: {
        containerId: typeOptions.containerId ?? '',
        ...(typeOptions.containerName ? { containerName: typeOptions.containerName } : {}),
      },
    };
  }
  return null;
}

// Runs a partial/reconstructed config through the Zod schema and flattens
// issue paths into dotted field keys the form recognises. Used by the Fix
// flow so the editor highlights exactly which fields made the invalid
// entry fail validation.
function collectFieldErrors(cfg: Record<string, unknown>): Array<{ fieldKey: string; message: string }> {
  const parse = RunConfigSchema.safeParse(cfg);
  if (parse.success) return [];
  return parse.error.issues.map(issue => ({
    fieldKey: issue.path.join('.'),
    message: issue.message,
  }));
}

export function deactivate(): void {
  log.info('Run Configurations deactivating.');
}
