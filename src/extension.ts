import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';
import { ConfigStore } from './services/ConfigStore';
import { CollapseStateStore } from './services/CollapseStateStore';
import { RunConfigService } from './services/RunConfigService';
import { ProjectScanner } from './services/ProjectScanner';
import { ExecutionService } from './services/ExecutionService';
import { DebugService } from './services/DebugService';
import { restartConfig } from './services/restartConfig';
import { RunStateStore } from './services/RunStateStore';
import { reattachOnStartup } from './services/reattachOnStartup';
import { scanPorts } from './services/PortScanner';
import { AdapterRegistry } from './adapters/AdapterRegistry';
import { NpmAdapter } from './adapters/npm/NpmAdapter';
import { SpringBootAdapter } from './adapters/spring-boot/SpringBootAdapter';
import { TomcatAdapter } from './adapters/tomcat/TomcatAdapter';
import { QuarkusAdapter } from './adapters/quarkus/QuarkusAdapter';
import { JavaAdapter } from './adapters/java/JavaAdapter';
import { PythonAdapter } from './adapters/python/PythonAdapter';
import { MavenGoalAdapter } from './adapters/maven-goal/MavenGoalAdapter';
import { GradleTaskAdapter } from './adapters/gradle-task/GradleTaskAdapter';
import { CustomCommandAdapter } from './adapters/custom-command/CustomCommandAdapter';
import { DockerAdapter } from './adapters/docker/DockerAdapter';
import { HttpRequestAdapter } from './adapters/http-request/HttpRequestAdapter';
import { GoAdapter } from './adapters/go/GoAdapter';
import { DockerService } from './services/DockerService';
import { RunConfigTreeProvider } from './ui/RunConfigTreeProvider';
import { NativeRunnerTreeProvider } from './ui/NativeRunnerTreeProvider';
import { EditorPanel } from './ui/EditorPanel';
import { MonitoringService } from './services/MonitoringService';
import { NodeMonitoringService } from './services/NodeMonitoringService';
import { MonitorPanel } from './ui/MonitorPanel';
import { NativeRunnerService, type NativeLaunch, type NativeTask } from './services/NativeRunnerService';
import { buildDependencyOptions, rcmRef } from './services/dependencyCandidates';
import { DependencyOrchestrator } from './services/DependencyOrchestrator';
import { resolveBuildContext, buildCommandFor, buildActionLabel, resolveNpmContext, npmCommandFor, npmActionLabel, resolvePythonContext, pythonCommandFor, pythonActionLabel, resolveGoContext, goCommandFor, goActionLabel, type NpmAction, type PythonAction, type GoAction } from './services/buildActions';
import { GroupService } from './services/GroupService';
import {
  NativeLaunchContentProvider,
  SCHEME as NATIVE_VIEW_SCHEME,
  launchViewUri,
  taskViewUri,
} from './ui/NativeLaunchContentProvider';
import { PortViewerPanel } from './ui/PortViewerPanel';
import { brandIconUri } from './ui/iconForConfig';
import { log, initLogger } from './utils/logger';
import { resolveProjectUri } from './utils/paths';
import type { RunConfig, RunConfigType } from './shared/types';
import type { InvalidConfigEntry } from './shared/types';
import { buildRecoveredConfig } from './recovery/buildRecoveredConfig';
import { RunConfigSchema } from './shared/schema';
import { EXTENSION_VERSION } from './utils/extensionVersion';
import * as crypto from 'crypto';
import { McpBridgeServer } from './services/McpBridgeServer';
import { createBridgeServices } from './mcp/bridgeServices';
import { decideAutoOpen } from './services/monitorAutoOpen';
import { registerMcpProvider } from './mcp/registerMcpProvider';

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
  registry.register(new PythonAdapter());
  registry.register(new MavenGoalAdapter());
  registry.register(new GradleTaskAdapter());
  registry.register(new CustomCommandAdapter());
  registry.register(new DockerAdapter(docker));
  registry.register(new HttpRequestAdapter());
  registry.register(new GoAdapter());
  log.debug(`Registered adapters: ${registry.all().map(a => a.type).join(', ')}`);

  const store = new ConfigStore();
  const svc = new RunConfigService(store);
  const scanner = new ProjectScanner(registry);
  const monitoring = new MonitoringService(context.extensionUri);
  context.subscriptions.push({ dispose: () => monitoring.dispose() });
  const nodeMonitoring = new NodeMonitoringService(context.extensionUri);
  context.subscriptions.push({ dispose: () => nodeMonitoring.dispose() });
  // Persisted run state for auto-reattach after a window / extension-host
  // reload. Lives in workspaceState so it survives the reload.
  const runState = new RunStateStore(context.workspaceState);
  const exec = new ExecutionService(registry, monitoring, svc, runState, nodeMonitoring);
  const dbg = new DebugService(registry, exec, nodeMonitoring);
  const native = new NativeRunnerService();
  context.subscriptions.push({ dispose: () => native.dispose() });

  const folders = vscode.workspace.workspaceFolders ?? [];
  log.debug(`Workspace folders: ${folders.length ? folders.map(f => f.uri.fsPath).join(', ') : '(none)'}`);
  await store.attach(folders);
  log.info(`Loaded ${svc.list().length} configuration(s) across ${folders.length} folder(s).`);

  const orchestrator = new DependencyOrchestrator(svc, exec, dbg, docker, native);
  const groups = new GroupService(svc);

  // MCP server: let AI agents read the config schema/guide and manage configs.
  // Gated behind a setting; the bridge listens lazily (first provider fetch).
  if (vscode.workspace.getConfiguration('runConfigManager').get<boolean>('mcp.enabled', true)) {
    const mcpToken = crypto.randomBytes(24).toString('hex');
    const bridgeServices = createBridgeServices({ svc, store, exec, dbg, monitoring, nodeMonitoring });
    const bridge = new McpBridgeServer(mcpToken, bridgeServices);
    context.subscriptions.push({ dispose: () => bridge.dispose() });
    context.subscriptions.push(
      registerMcpProvider(context, { port: () => bridge.listenPort(), token: mcpToken }),
    );
  }
  const collapseState = new CollapseStateStore(context.workspaceState);
  const tree = new RunConfigTreeProvider(store, svc, exec, dbg, registry, context.extensionUri, docker, orchestrator, native, groups, monitoring, collapseState, nodeMonitoring);
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
    // The tree provider also implements TreeDragAndDropController so
    // users can drag configs between folders / drop onto a folder to
    // assign / drag back to root to ungroup.
    dragAndDropController: tree,
  });
  // Persist user-driven expand/collapse for folder/typeGroup/group rows
  // so reloading VS Code restores the last view state. Listeners only
  // record nodes our store cares about; everything else is a no-op.
  context.subscriptions.push(
    view.onDidExpandElement(e => {
      const id = tree.collapseStateIdFor(e.element);
      if (id) collapseState.set(id, 'expanded');
    }),
    view.onDidCollapseElement(e => {
      const id = tree.collapseStateIdFor(e.element);
      if (id) collapseState.set(id, 'collapsed');
    }),
  );
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

  // Auto-open the monitor view when a config gains monitoring state. Monitoring
  // only ever attaches when { monitor: true } was requested, so this fires for
  // exactly the monitored-start paths (runMonitored/debugMonitored commands and
  // the MCP run_config/debug_config monitor path). One reactive hook covers all
  // of them. The guard set prevents re-opening a panel the user closed mid-run;
  // it is cleared on detach so the next monitored run re-opens.
  const autoOpenedMonitors = new Set<string>();
  const maybeAutoOpenMonitor = (id: string): void => {
    const enabled = vscode.workspace
      .getConfiguration('runConfigManager')
      .get<boolean>('monitoring.autoOpenView', true);
    const live = !!(monitoring.state(id) || nodeMonitoring.state(id));
    const action = decideAutoOpen({ enabled, live, alreadyOpened: autoOpenedMonitors.has(id) });
    if (action === 'clear') {
      autoOpenedMonitors.delete(id);
      return;
    }
    if (action === 'noop') return;
    const ref = svc.getById(id);
    if (!ref || !ref.valid) return;
    autoOpenedMonitors.add(id);
    MonitorPanel.open(ref.config as RunConfig, context.extensionUri, monitoring, nodeMonitoring);
  };
  context.subscriptions.push(monitoring.onChanged(maybeAutoOpenMonitor));
  context.subscriptions.push(nodeMonitoring.onChanged(maybeAutoOpenMonitor));

  // Auto-reattach: after a window / extension-host reload, ExecutionService's
  // in-memory state is gone. Find configs the extension started before the
  // reload that are still listening on their recorded port and mark them
  // running again (Stop will kill the live process). Best-effort and fully
  // async so activation isn't blocked on a port scan.
  void reattachOnStartup({
    runState,
    reattach: (id, pid, ports) => exec.reattach(id, pid, ports),
    configExists: (id) => svc.getById(id)?.valid === true,
    scan: scanPorts,
  })
    .then(n => {
      if (n > 0) {
        log.info(`Reattached ${n} running configuration(s) after reload.`);
        tree.refresh();
        updateRunningState();
      }
    })
    .catch(e => log.warn(`reattach on startup failed: ${(e as Error).message}`));

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
          streaming: buildStreamingPayload(adapter, { ...detectionContext, dependencyOptions }),
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
          streaming: buildStreamingPayload(adapter, { ...detectionContext, dependencyOptions }),
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

    vscode.commands.registerCommand('runConfig.run', async (arg: any) => {
      // Dep nodes (depRcm/depLaunch/depTask) reuse the run/stop commands so
      // their inline menu entries can run/stop the dependency directly. We
      // resolve them up-front to a `kind: 'config'` shape (or delegate to
      // the native runner for launch/task deps). depMissing is a no-op.
      const resolved = resolveCommandTarget(arg, store);
      if (!resolved) return;
      if (resolved.kind === 'native-launch') {
        await native.runLaunch(resolved.launch);
        return;
      }
      if (resolved.kind === 'native-task') {
        const list = await native.getTasks();
        const found = list.find(t => t.source === resolved.source && t.name === resolved.taskName);
        if (!found) {
          vscode.window.showWarningMessage(`Task "${resolved.taskName}" not found.`);
          return;
        }
        await native.runTask(found);
        return;
      }
      const { config, folder } = resolved;
      log.info(`Run: "${config.name}" (${config.type})`);

      // When the config has dependencies, fan out through the orchestrator.
      // It starts each dep in order, waits for running-state, applies the
      // per-edge delay, then starts the root. The tree expands / collapses
      // automatically — the provider flips the root and nested depRcm nodes
      // to Expanded while an orchestration snapshot is active, then back to
      // Collapsed when it clears ~1.5s after the root reports running.
      if ((config.dependsOn?.length ?? 0) > 0) {
        await orchestrator.run(config, folder);
        return;
      }

      if (config.type === 'docker') {
        // Docker bypasses ExecutionService entirely — start/stop are
        // one-shot daemon calls and the "running" state comes from polling.
        try {
          await docker.startContainer(config.typeOptions.containerId);
        } catch (e) {
          vscode.window.showErrorMessage(`docker start failed: ${(e as Error).message}`);
        }
        return;
      }
      await exec.run(config, folder);
    }),

    vscode.commands.registerCommand('runConfig.stop', async (arg: any) => {
      const resolved = resolveCommandTarget(arg, store);
      if (!resolved) return;
      if (resolved.kind === 'native-launch') {
        await native.stopLaunch(resolved.launch.name);
        return;
      }
      if (resolved.kind === 'native-task') {
        await native.stopTask(resolved.source, resolved.taskName);
        return;
      }
      const { config } = resolved;
      log.info(`Stop: "${config.name}"`);
      if (config.type === 'docker') {
        try {
          await docker.stopContainer(config.typeOptions.containerId);
        } catch (e) {
          vscode.window.showErrorMessage(`docker stop failed: ${(e as Error).message}`);
        }
        return;
      }
      // A single config can be either in a run task OR a debug session.
      // Stop whichever is actually tracking it.
      if (dbg.isRunning(config.id)) {
        await dbg.stop(config.id);
      } else {
        await exec.stop(config.id);
      }
    }),

    vscode.commands.registerCommand('runConfig.restart', async (arg: ConfigNodeArg) => {
      const resolved = resolveCommandTarget(arg, store);
      if (!resolved || resolved.kind !== 'config') return; // restart only applies to RCM configs
      const { config, folder } = resolved;
      log.info(`Restart: "${config.name}"`);
      await restartConfig({ exec, dbg, monitoring }, config, folder);
    }),

    vscode.commands.registerCommand('runConfig.debug', async (arg: any) => {
      const resolved = resolveCommandTarget(arg, store);
      // Debug only applies to RCM-config targets; native launch/task deps
      // don't have a debug semantic in this command.
      if (!resolved || resolved.kind !== 'config') return;
      const { config, folder } = resolved;
      log.info(`Debug: "${config.name}" (${config.type})`);
      await dbg.debug(config, folder);
    }),

    // --- JVM Monitoring (Run/Debug with monitoring agent + Open Monitor view) ---
    //
    // Run/Debug variants pass `{ monitor: true }` through the prepare-context
    // chain; the JVM adapters (spring-boot, tomcat, quarkus, java) inject the
    // bundled agent as a JVMTI/javaagent flag. Once the JVM starts, the
    // ExecutionService/DebugService asks MonitoringService.attach(...) which
    // spins up the in-process metrics socket. Open Monitor reveals the
    // webview backed by MonitoringService state.
    vscode.commands.registerCommand('runConfig.runMonitored', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      log.info(`Run with monitoring: "${arg.config.name}"`);
      // When the config has dependencies, fan out through the orchestrator so
      // deps come up first; the orchestrator forwards `{ monitor: true }` to
      // the root launch only.
      if ((arg.config.dependsOn?.length ?? 0) > 0) {
        await orchestrator.run(arg.config, folder, { monitor: true });
        return;
      }
      await exec.run(arg.config, folder, { monitor: true });
    }),
    vscode.commands.registerCommand('runConfig.debugMonitored', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      log.info(`Debug with monitoring: "${arg.config.name}"`);
      if ((arg.config.dependsOn?.length ?? 0) > 0) {
        await orchestrator.run(arg.config, folder, { debug: true, monitor: true });
        return;
      }
      await dbg.debug(arg.config, folder, { monitor: true });
    }),
    vscode.commands.registerCommand('runConfig.openMonitor', (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      MonitorPanel.open(arg.config, context.extensionUri, monitoring, nodeMonitoring);
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
        ? resolveProjectUri(folder, recovered.projectPath)
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
        streaming: buildStreamingPayload(adapter, { ...(detection?.context ?? {}), dependencyOptions }),
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
    vscode.commands.registerCommand('runConfig.npmAction.install', (arg: ConfigNodeArg) => runNpmActionFor(arg, 'install', store, svc)),
    vscode.commands.registerCommand('runConfig.npmAction.update',  (arg: ConfigNodeArg) => runNpmActionFor(arg, 'update',  store, svc)),
    vscode.commands.registerCommand('runConfig.npmAction.prune',   (arg: ConfigNodeArg) => runNpmActionFor(arg, 'prune',   store, svc)),
    vscode.commands.registerCommand('runConfig.pythonAction.installEditable',     (arg: ConfigNodeArg) => runPythonActionFor(arg, 'installEditable',     store)),
    vscode.commands.registerCommand('runConfig.pythonAction.installRequirements', (arg: ConfigNodeArg) => runPythonActionFor(arg, 'installRequirements', store)),
    vscode.commands.registerCommand('runConfig.pythonAction.upgrade',             (arg: ConfigNodeArg) => runPythonActionFor(arg, 'upgrade',             store)),
    vscode.commands.registerCommand('runConfig.pythonAction.freeze',              (arg: ConfigNodeArg) => runPythonActionFor(arg, 'freeze',              store)),
    vscode.commands.registerCommand('runConfig.pythonAction.list',                (arg: ConfigNodeArg) => runPythonActionFor(arg, 'list',                store)),
    vscode.commands.registerCommand('runConfig.goAction.modTidy',    (arg: ConfigNodeArg) => runGoActionFor(arg, 'modTidy',    store)),
    vscode.commands.registerCommand('runConfig.goAction.modDownload', (arg: ConfigNodeArg) => runGoActionFor(arg, 'modDownload', store)),
    vscode.commands.registerCommand('runConfig.goAction.build',      (arg: ConfigNodeArg) => runGoActionFor(arg, 'build',      store)),
    vscode.commands.registerCommand('runConfig.goAction.test',       (arg: ConfigNodeArg) => runGoActionFor(arg, 'test',       store)),

    // --- Groups (user-defined) ---

    vscode.commands.registerCommand('runConfig.addToGroup', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      const existing = groups.list(arg.folderKey);
      // QuickPick offers every existing group + a sentinel row for creating
      // a new one. Picking the sentinel triggers an input box — one-step
      // flow without a separate command.
      const NEW_SENTINEL = '$(add) Create new folder…';
      // The picker shows every known folder (top-level + nested), so
      // users can drop a config directly into a sub-folder. The
      // sentinel row triggers an inline input for typing a fresh path
      // (which can include "/" to create nested folders in one step).
      const items: vscode.QuickPickItem[] = [
        ...existing.map(path => ({
          label: path,
          description: path.includes('/') ? 'sub-folder' : 'folder',
        })),
        ...(existing.length ? [{ label: '', kind: vscode.QuickPickItemKind.Separator } as vscode.QuickPickItem] : []),
        { label: NEW_SENTINEL, description: 'type a name (slashes allowed for nested folders)' },
      ];
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: `Add "${arg.config.name}" to which folder?`,
      });
      if (!pick) return;
      let targetName: string | undefined;
      if (pick.label === NEW_SENTINEL) {
        targetName = await vscode.window.showInputBox({
          prompt: 'New folder path',
          placeHolder: 'e.g. Backend, Smoke test, or Backend/API',
          validateInput: v => {
            const t = v.trim();
            if (!t) return 'Folder path cannot be empty';
            if (t.startsWith('/') || t.endsWith('/') || t.includes('//')) {
              return 'Folder paths use "/" as separator; segments cannot be empty.';
            }
            if (existing.includes(t)) return `Folder "${t}" already exists — pick it from the list instead`;
            return null;
          },
        });
      } else {
        targetName = pick.label;
      }
      if (!targetName) return;
      try {
        await groups.addToGroup(arg.folderKey, arg.config.id, targetName);
      } catch (e) {
        vscode.window.showErrorMessage(`Add to group failed: ${(e as Error).message}`);
      }
    }),

    vscode.commands.registerCommand('runConfig.removeFromGroup', async (arg: ConfigNodeArg) => {
      if (!arg || arg.kind !== 'config') return;
      try {
        await groups.removeFromGroup(arg.folderKey, arg.config.id);
      } catch (e) {
        vscode.window.showErrorMessage(`Remove from group failed: ${(e as Error).message}`);
      }
    }),

    // Group-row actions (right-click a group folder):
    // Folders are paths now ("Backend/API"); the tree node carries
    // both `path` (full slash path) and `name` (last segment for
    // display). Commands operate on the path.
    vscode.commands.registerCommand('runConfig.runGroupSequential', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      await runGroup(arg.folderKey, arg.path, 'sequential', false, groups, store, exec, dbg, docker, orchestrator, svc);
    }),
    vscode.commands.registerCommand('runConfig.runGroupParallel', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      await runGroup(arg.folderKey, arg.path, 'parallel', false, groups, store, exec, dbg, docker, orchestrator, svc);
    }),
    vscode.commands.registerCommand('runConfig.debugGroupSequential', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      await runGroup(arg.folderKey, arg.path, 'sequential', true, groups, store, exec, dbg, docker, orchestrator, svc);
    }),
    vscode.commands.registerCommand('runConfig.debugGroupParallel', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      await runGroup(arg.folderKey, arg.path, 'parallel', true, groups, store, exec, dbg, docker, orchestrator, svc);
    }),
    vscode.commands.registerCommand('runConfig.stopGroup', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      const folder = store.getFolder(arg.folderKey);
      if (!folder) return;
      await groups.stopGroup(arg.folderKey, arg.path, { exec, dbg, docker });
    }),
    vscode.commands.registerCommand('runConfig.renameGroup', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      // Renaming a folder also rewrites every descendant path; the
      // service handles the cascade. We only validate the new last-
      // segment is non-empty + slash-free.
      const existingFolders = groups.list(arg.folderKey).filter(n => n !== arg.path);
      const currentName = arg.name as string;
      const next = await vscode.window.showInputBox({
        prompt: `Rename folder "${arg.path}"`,
        value: currentName,
        validateInput: v => {
          const t = v.trim();
          if (!t) return 'Folder name cannot be empty';
          if (t.includes('/')) return 'Use the right-click menu / drag-and-drop to nest folders; "/" isn\'t allowed in a name';
          // Build the full new path by replacing the last segment of
          // arg.path with the user's input. Block collisions.
          const parent = arg.path.includes('/') ? arg.path.slice(0, arg.path.lastIndexOf('/')) : '';
          const fullNew = parent ? `${parent}/${t}` : t;
          if (fullNew !== arg.path && existingFolders.includes(fullNew)) {
            return `Folder "${fullNew}" already exists`;
          }
          return null;
        },
      });
      if (!next || next.trim() === currentName) return;
      const parent = arg.path.includes('/') ? arg.path.slice(0, arg.path.lastIndexOf('/')) : '';
      const fullNew = parent ? `${parent}/${next.trim()}` : next.trim();
      try {
        await groups.renameGroup(arg.folderKey, arg.path, fullNew);
      } catch (e) {
        vscode.window.showErrorMessage(`Rename folder failed: ${(e as Error).message}`);
      }
    }),
    vscode.commands.registerCommand('runConfig.deleteGroup', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      const members = groups.members(arg.folderKey, arg.path, { recursive: true });
      const confirm = await vscode.window.showWarningMessage(
        `Delete folder "${arg.path}"?`,
        {
          modal: true,
          detail: members.length
            ? `The ${members.length} member config(s) (including in sub-folders) will NOT be deleted — they'll move back to the top level. Sub-folders themselves will be removed.`
            : 'The folder is empty.',
        },
        'Delete',
      );
      if (confirm !== 'Delete') return;
      try {
        await groups.deleteFolder(arg.folderKey, arg.path);
      } catch (e) {
        vscode.window.showErrorMessage(`Delete folder failed: ${(e as Error).message}`);
      }
    }),

    // The `+` button on a group/folder row offers "Add subfolder" or
    // "Add another configuration to this folder" via a quickPick.
    vscode.commands.registerCommand('runConfig.folder.addItem', async (arg: any) => {
      if (!arg || arg.kind !== 'group') return;
      const action = await vscode.window.showQuickPick(
        [
          { label: '$(new-folder) Add sub-folder', detail: 'Create an empty sub-folder under this one', value: 'subfolder' as const },
          { label: '$(file-add) Add an existing configuration', detail: 'Move a config from another folder (or top-level) into this folder', value: 'existing' as const },
        ],
        { placeHolder: `Add to "${arg.path}"` },
      );
      if (!action) return;

      if (action.value === 'subfolder') {
        // Inline name validation: same rules as the rename flow plus
        // "no path separator" (creating a deeply nested subfolder
        // should be an explicit chain of clicks, not one input box).
        const existingFolders = new Set(groups.list(arg.folderKey));
        const name = await vscode.window.showInputBox({
          prompt: `New sub-folder under "${arg.path}"`,
          placeHolder: 'Folder name',
          validateInput: v => {
            const t = v.trim();
            if (!t) return 'Folder name cannot be empty';
            if (t.includes('/')) return '"/" isn\'t allowed in a folder name (sub-folders are added one level at a time)';
            const fullNew = `${arg.path}/${t}`;
            if (existingFolders.has(fullNew)) return `Folder "${fullNew}" already exists`;
            return null;
          },
        });
        if (!name) return;
        try {
          await groups.addFolder(arg.folderKey, `${arg.path}/${name.trim()}`);
        } catch (e) {
          vscode.window.showErrorMessage(`Add sub-folder failed: ${(e as Error).message}`);
        }
        return;
      }

      // Move-existing flow. Show every config in this workspace folder
      // that isn't already in the target. We deliberately allow picking
      // a config currently in some other folder — the action moves it.
      const candidates = svc.list()
        .filter((r): r is Extract<typeof r, { valid: true }> => r.valid && r.folderKey === arg.folderKey)
        .map(r => r.config)
        .filter(c => (c.group ?? '') !== arg.path);
      if (candidates.length === 0) {
        vscode.window.showInformationMessage(`No other configurations available to add to "${arg.path}".`);
        return;
      }
      const picked = await vscode.window.showQuickPick(
        candidates.map(c => ({
          label: c.name,
          description: c.group ? `currently in: ${c.group}` : 'currently top-level',
          detail: c.type,
          configId: c.id,
        })),
        { placeHolder: `Add a configuration to "${arg.path}"` },
      );
      if (!picked) return;
      try {
        await groups.moveConfig(arg.folderKey, picked.configId, arg.path);
      } catch (e) {
        vscode.window.showErrorMessage(`Move failed: ${(e as Error).message}`);
      }
    }),

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
        const skeleton = JSON.stringify({ version: EXTENSION_VERSION, configurations: [] }, null, 2) + '\n';
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(skeleton));
      }
      log.info(`Open run.json: ${uri.fsPath}`);
      await vscode.commands.executeCommand('vscode.open', uri);
    }),

    // --- Find Blocking Ports ---

    vscode.commands.registerCommand('runConfig.findBlockingPorts', () => {
      log.info('Command: find blocking ports');
      PortViewerPanel.open(svc, exec, dbg, docker);
    }),

    view,
    { dispose: () => store.dispose() },
    { dispose: () => exec.dispose() },
    { dispose: () => dbg.dispose() },
    { dispose: () => log.dispose() },
  );

  log.info('Run Configurations ready.');
}

// Resolves whichever node kind the user clicked into a uniform "what
// should run/stop do?" shape. Accepts `kind: 'config'` (regular config
// row), depRcm (the dep's underlying RunConfig), depLaunch (delegate to
// native launch runner), depTask (delegate to native task runner). Drops
// depMissing and unknown shapes. Pulled into a helper so run/stop/debug
// don't repeat the same dispatch.
type CommandTarget =
  | { kind: 'config'; config: RunConfig; folder: vscode.WorkspaceFolder }
  | { kind: 'native-launch'; launch: NativeLaunch }
  | { kind: 'native-task'; source: string; taskName: string };

function resolveCommandTarget(arg: any, store: ConfigStore): CommandTarget | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  if (arg.kind === 'config' && arg.config && arg.folderKey) {
    const folder = store.getFolder(arg.folderKey);
    if (!folder) return undefined;
    return { kind: 'config', config: arg.config as RunConfig, folder };
  }
  if (arg.kind === 'depRcm' && arg.config) {
    const cfg = arg.config as RunConfig;
    // Resolve the workspace folder by name (depRcm carries cfg, which has
    // workspaceFolder). Fall back to the first folder when the lookup
    // fails — matches `RunConfigTreeProvider.folderKeyOf` semantics.
    const folders = vscode.workspace.workspaceFolders ?? [];
    const folder = folders.find(f => f.name === cfg.workspaceFolder) ?? folders[0];
    if (!folder) return undefined;
    return { kind: 'config', config: cfg, folder };
  }
  if (arg.kind === 'depLaunch' && arg.launchName) {
    return {
      kind: 'native-launch',
      launch: { name: arg.launchName, launchType: arg.launchType ?? '' } as NativeLaunch,
    };
  }
  if (arg.kind === 'depTask' && arg.source && arg.taskName) {
    return { kind: 'native-task', source: arg.source, taskName: arg.taskName };
  }
  return undefined;
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

  // Step 1: pick the config type — this is the user's first decision.
  // Workspace folder (in multi-root setups) and project folder come after,
  // because the type determines whether a folder picker is needed at all.
  const typePick = await vscode.window.showQuickPick(
    // Sort alphabetically by display label and attach the matching brand
    // icon so the picker mirrors what the tree shows for already-created
    // configs. iconPath accepts a {light, dark} URI pair which VS Code
    // resolves per active theme.
    registry.all()
      .map(a => ({
        label: a.label,
        value: a.type as RunConfigType,
        iconPath: brandIconUri(brandForType(a.type as RunConfigType), context.extensionUri),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    { placeHolder: 'Run configuration type' },
  );
  if (!typePick) return;

  const adapter = registry.get(typePick.value)!;

  // Step 2: workspace folder (only relevant in multi-root workspaces).
  let folder: vscode.WorkspaceFolder | undefined;
  if (folders.length === 1) folder = folders[0];
  else folder = await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Workspace folder' });
  if (!folder) return;

  // Step 3: project root folder — only for adapters that need it.
  // Adapters that declare needsFolderPick = false (docker, http-request,
  // custom-command, maven-goal, gradle-task) use the workspace root as
  // projectPath; the user can adjust it in the form.
  let projectUri: vscode.Uri;
  if (adapter.needsFolderPick !== false) {
    const projectFolderUris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      defaultUri: folder.uri,
      openLabel: 'Use this as project root',
    });
    if (!projectFolderUris || projectFolderUris.length === 0) return;
    projectUri = projectFolderUris[0];
  } else {
    projectUri = folder.uri;
  }

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
      streaming: buildStreamingPayload(adapter, { dependencyOptions }),
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
// Dispatches a group's members through the GroupService (which handles the
// queued/running/failed status bookkeeping). Kept as a tiny shim so the
// command registrations stay one-liners.
async function runGroup(
  folderKey: string,
  name: string,
  mode: 'sequential' | 'parallel',
  debug: boolean,
  groups: GroupService,
  store: ConfigStore,
  exec: ExecutionService,
  dbg: DebugService,
  docker: DockerService,
  orchestrator: DependencyOrchestrator,
  _svc: RunConfigService,
): Promise<void> {
  const folder = store.getFolder(folderKey);
  if (!folder) return;
  await groups.runGroup(folderKey, name, mode, folder, { exec, dbg, docker, orchestrator }, { debug });
}

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

async function runNpmActionFor(
  arg: any,
  action: NpmAction,
  store: ConfigStore,
  svc: RunConfigService,
): Promise<void> {
  let cfg: RunConfig | undefined;
  let folderKey: string | undefined;
  if (arg?.kind === 'config') { folderKey = arg.folderKey; cfg = arg.config; }
  if (!cfg || !folderKey) return;
  const folder = store.getFolder(folderKey);
  if (!folder) return;
  const ctx = resolveNpmContext(cfg, folder);
  if (!ctx) {
    vscode.window.showWarningMessage(`"${cfg.name}" is not an npm-based config.`);
    return;
  }
  const args = npmCommandFor(ctx, action);
  const execution = new vscode.ShellExecution(ctx.packageManager, args, { cwd: ctx.cwd });
  const taskName = `${cfg.name} · ${ctx.packageManager} ${npmActionLabel(action).toLowerCase()}`;
  const task = new vscode.Task(
    { type: 'rcm-npm', configId: cfg.id, action } as any,
    folder,
    taskName,
    'Run Configurations',
    execution,
    [],
  );
  log.info(`npm action: ${taskName} (cwd=${ctx.cwd})`);
  try {
    await vscode.tasks.executeTask(task);
  } catch (e) {
    vscode.window.showErrorMessage(`npm action failed to start: ${(e as Error).message}`);
  }
}

async function runPythonActionFor(
  arg: any,
  action: PythonAction,
  store: ConfigStore,
): Promise<void> {
  let cfg: RunConfig | undefined;
  let folderKey: string | undefined;
  if (arg?.kind === 'config') { folderKey = arg.folderKey; cfg = arg.config; }
  if (!cfg || !folderKey) return;
  const folder = store.getFolder(folderKey);
  if (!folder) return;
  const ctx = resolvePythonContext(cfg, folder);
  if (!ctx) {
    vscode.window.showWarningMessage(`"${cfg.name}" is not a Python config.`);
    return;
  }

  // Pre-flight per action: gate installs that need a manifest. Without
  // this guard, "Install requirements" on a project without
  // requirements.txt would fail noisily; "Install (editable)" on a
  // project without pyproject.toml would error from pip itself. We
  // trade those for clearer warnings up front.
  if (action === 'installRequirements' && ctx.manifestKind !== 'requirements' && ctx.manifestKind !== 'pyproject+requirements') {
    vscode.window.showWarningMessage(
      `"${cfg.name}" project has no requirements.txt at ${ctx.cwd}. Try "Install (editable)" instead.`,
    );
    return;
  }
  if (action === 'installEditable' && ctx.manifestKind !== 'pyproject' && ctx.manifestKind !== 'pyproject+requirements') {
    vscode.window.showWarningMessage(
      `"${cfg.name}" project has no pyproject.toml at ${ctx.cwd}. Try "Install requirements" instead.`,
    );
    return;
  }

  // Resolve the python binary (handles empty pythonPath → PATH lookup,
  // and POSIX vs Windows). Reuses the shared interpreter-binary helper
  // shape from runInTerminal.
  const isWin = os.platform() === 'win32';
  const bin = !ctx.pythonPath
    ? 'python3'
    : isWin
      ? path.join(ctx.pythonPath, 'python.exe')
      : path.join(ctx.pythonPath, 'bin', 'python3');
  const args = pythonCommandFor(ctx, action);
  const execution = new vscode.ShellExecution(bin, args, { cwd: ctx.cwd });
  const taskName = `${cfg.name} · ${pythonActionLabel(action).toLowerCase()}`;
  const task = new vscode.Task(
    { type: 'rcm-python', configId: cfg.id, action } as any,
    folder,
    taskName,
    'Run Configurations',
    execution,
    [],
  );
  log.info(`python action: ${taskName} (cwd=${ctx.cwd}, py=${bin})`);
  try {
    await vscode.tasks.executeTask(task);
  } catch (e) {
    vscode.window.showErrorMessage(`Python action failed to start: ${(e as Error).message}`);
  }
}

async function runGoActionFor(
  arg: any,
  action: GoAction,
  store: ConfigStore,
): Promise<void> {
  let cfg: RunConfig | undefined;
  let folderKey: string | undefined;
  if (arg?.kind === 'config') { folderKey = arg.folderKey; cfg = arg.config; }
  if (!cfg || !folderKey) return;
  const folder = store.getFolder(folderKey);
  if (!folder) return;
  const ctx = resolveGoContext(cfg, folder);
  if (!ctx) {
    vscode.window.showWarningMessage(`"${cfg.name}" is not a Go config.`);
    return;
  }
  const args = goCommandFor(ctx, action);
  const execution = new vscode.ShellExecution(ctx.binary, args, { cwd: ctx.cwd });
  const taskName = `${cfg.name} · ${goActionLabel(action)}`;
  const task = new vscode.Task(
    { type: 'rcm-go', configId: cfg.id, action } as any,
    folder,
    taskName,
    'Run Configurations',
    execution,
    [],
  );
  log.info(`go action: ${taskName} (cwd=${ctx.cwd}, go=${ctx.binary})`);
  try {
    await vscode.tasks.executeTask(task);
  } catch (e) {
    vscode.window.showErrorMessage(`Go action failed to start: ${(e as Error).message}`);
  }
}

async function buildEditContext(
  adapter: { detect: (uri: vscode.Uri) => Promise<{ context: Record<string, unknown> } | null> },
  folder: vscode.WorkspaceFolder,
  projectPath: string,
): Promise<Record<string, unknown>> {
  const projectUri = projectPath
    ? resolveProjectUri(folder, projectPath)
    : folder.uri;
  try {
    const detection = await adapter.detect(projectUri);
    return detection?.context ?? {};
  } catch {
    return {};
  }
}

// Fields whose options come from streaming detection. The webview shows
// spinners on these keys until schemaUpdate messages arrive. Used to seed
// the EditorPanel.streaming.pending list in both create and edit flows so
// the JDK / Node / Tomcat / etc. dropdowns refresh against the user's
// current environment when reopening an existing config.
const STREAMING_PENDING_FIELDS = [
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
  // npm
  'typeOptions.nodePath',
  // python
  'typeOptions.pythonPath',
];

// Builds the EditorPanel `streaming` payload, used by both the create
// and edit flows. Only returns a value when the adapter actually
// supports streaming detection — caller passes the result through.
function buildStreamingPayload(
  adapter: import('./adapters/RuntimeAdapter').RuntimeAdapter,
  initialContext: Record<string, unknown>,
) {
  if (!adapter.detectStreaming) return undefined;
  return {
    adapter,
    initialContext,
    pending: STREAMING_PENDING_FIELDS,
  };
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
        nodePath: typeOptions.nodePath ?? '',
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

// Maps a RunConfigType to its brand icon name under media/icons/ for use in
// the type-pick QuickPick. Mirrors `iconForConfig.computeBrand` but takes
// just the type (the QuickPick has no full RunConfig to inspect, so the
// npm-subtype sniffing the tree does isn't relevant here — pre-creation,
// the user hasn't picked a folder's actual contents yet).
function brandForType(type: RunConfigType): string {
  switch (type) {
    case 'spring-boot':    return 'spring-boot';
    case 'tomcat':         return 'tomcat';
    case 'quarkus':        return 'quarkus';
    case 'java':           return 'java';
    case 'python':         return 'python';
    case 'maven-goal':     return 'maven';
    case 'gradle-task':    return 'gradle';
    case 'custom-command': return 'bash';
    case 'docker':         return 'docker';
    case 'http-request':   return 'http-request';
    case 'npm':            return 'npm';
    case 'go':             return 'go';
  }
}

export function deactivate(): void {
  log.info('Run Configurations deactivating.');
}
