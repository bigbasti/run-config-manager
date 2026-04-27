import * as vscode from 'vscode';
import type { RuntimeAdapter, DetectionResult, StreamingPatch } from '../RuntimeAdapter';
import type { RunConfig } from '../../shared/types';
import type { FormSchema, InfoContent } from '../../shared/formSchema';
import type { DockerService, ContainerSummary, ContainerInfo } from '../../services/DockerService';
import { log } from '../../utils/logger';

// The Docker adapter is a thin bridge between the form UI and DockerService.
// Key differences from the other adapters:
//   - buildCommand is a no-op stub. Start/stop are handled outside
//     ExecutionService — extension.ts intercepts runConfig.run / runConfig.stop
//     for docker configs and calls DockerService directly.
//   - Click-on-config opens a logs terminal instead of the editor; that's
//     also wired in RunConfigTreeProvider + extension.ts.
//   - The form's container dropdown + info panel are populated by streaming
//     detection — the list can change any time (containers come and go) so
//     we re-emit each poll.
export class DockerAdapter implements RuntimeAdapter {
  readonly type = 'docker' as const;
  readonly label = 'Docker';
  readonly supportsDebug = false;

  constructor(private readonly docker: DockerService) {}

  async detect(_folder: vscode.Uri): Promise<DetectionResult | null> {
    // Docker configs are user-initiated (no folder marker is meaningful).
    // We still advertise ourselves so "Add Run Configuration" presents
    // Docker as a type; just return empty defaults.
    return {
      defaults: { type: 'docker', typeOptions: { containerId: '' } },
      context: {
        containers: this.docker.list(),
        dockerAvailable: this.docker.isAvailable(),
        dockerError: this.docker.listError(),
      },
    };
  }

  async detectStreaming(
    _folder: vscode.Uri,
    emit: (patch: StreamingPatch) => void,
  ): Promise<void> {
    // Initial schema uses whatever the poller has seen so far — the form
    // renders immediately with the current container list.
    emit({
      contextPatch: {
        containers: this.docker.list(),
        dockerAvailable: this.docker.isAvailable(),
        dockerError: this.docker.listError(),
      },
      resolved: [],
    });
    // Kick a fresh fetch so the dropdown reflects the world as of "now".
    try {
      await this.docker.refresh();
      emit({
        contextPatch: {
          containers: this.docker.list(),
          dockerAvailable: this.docker.isAvailable(),
          dockerError: this.docker.listError(),
        },
        resolved: ['typeOptions.containerId'],
      });
    } catch (e) {
      log.warn(`Docker container list refresh failed: ${(e as Error).message}`);
    }
  }

  getFormSchema(context: Record<string, unknown>): FormSchema {
    const containers = (context.containers as ContainerSummary[] | undefined) ?? [];
    const dockerAvailable = context.dockerAvailable as boolean | undefined;
    const dockerError = context.dockerError as string | undefined;
    const selectedInfo = context.selectedContainerInfo as ContainerInfo | undefined;
    const selectedId = context.selectedContainerId as string | undefined;

    // Sort: running first, then everything else by name. Users almost always
    // want to pick from what's already up.
    const sorted = [...containers].sort((a, b) => {
      const aRun = a.state === 'running' ? 0 : 1;
      const bRun = b.state === 'running' ? 0 : 1;
      if (aRun !== bRun) return aRun - bRun;
      return a.name.localeCompare(b.name);
    });

    const options = sorted.map(c => ({
      value: c.id,
      label: c.name || c.id.slice(0, 12),
      group: c.state === 'running' ? 'Running' : 'Stopped / other',
      description: `${c.image}  ·  ${c.status}`,
    }));

    const infoContent = buildInfoContent({
      containers,
      selectedId,
      selectedInfo,
      dockerAvailable,
      dockerError,
    });

    return {
      common: [
        {
          kind: 'text',
          key: 'name',
          label: 'Name',
          required: true,
          placeholder: 'postgres (dev)',
          help:
            'Display name shown in the sidebar. Prefilled from the container name when you pick one — overwrite for a friendlier label.',
          examples: ['DB (dev)', 'redis', 'Mock SOAP'],
        },
      ],
      typeSpecific: [
        {
          kind: 'selectOrCustom',
          key: 'typeOptions.containerId',
          label: 'Container',
          required: true,
          options,
          placeholder: 'Pick a container, or paste an id',
          help:
            containers.length === 0
              ? (dockerAvailable === false
                  ? `Docker isn't reachable on this machine. Start Docker Desktop / dockerd and click "Refresh" in the sidebar. Last error: ${dockerError ?? 'unknown'}`
                  : 'No containers visible yet. Containers appear here as soon as they\'re created (started or not). If you create one now, click "Refresh" in the sidebar.')
              : 'Pick a container by name. The info panel below updates when you select.',
          examples: containers.slice(0, 3).map(c => c.id.slice(0, 12)),
        },
        {
          kind: 'info',
          key: 'typeOptions.containerInfo',
          label: 'Container details',
          content: infoContent,
        },
      ],
      advanced: [],
    };
  }

  buildCommand(_cfg: RunConfig, _folder?: vscode.WorkspaceFolder): { command: string; args: string[] } {
    // Never actually invoked — extension.ts intercepts run/stop for docker
    // configs before they reach ExecutionService. Return a harmless stub so
    // anyone calling buildCommand for preview purposes gets something.
    return { command: 'docker', args: ['start'] };
  }
}

function buildInfoContent(args: {
  containers: ContainerSummary[];
  selectedId: string | undefined;
  selectedInfo: ContainerInfo | undefined;
  dockerAvailable: boolean | undefined;
  dockerError: string | undefined;
}): InfoContent {
  const { selectedId, selectedInfo, dockerAvailable, dockerError } = args;

  if (dockerAvailable === false) {
    return {
      banner: {
        kind: 'warning',
        text: `Docker daemon unreachable. ${dockerError ?? ''}`.trim(),
      },
    };
  }
  if (!selectedId) {
    return {
      banner: { kind: 'muted', text: 'Pick a container to see details.' },
    };
  }
  if (!selectedInfo) {
    return {
      banner: { kind: 'muted', text: `Loading details for ${selectedId.slice(0, 12)}…` },
    };
  }

  const rows: Array<{ label: string; value: string }> = [
    { label: 'Id', value: selectedInfo.id.slice(0, 12) },
    { label: 'Name', value: selectedInfo.name || '(unnamed)' },
    { label: 'Image', value: selectedInfo.image || '(unknown)' },
    { label: 'State', value: selectedInfo.state },
    { label: 'Created', value: humanDate(selectedInfo.created) },
  ];

  const lists: InfoContent['lists'] = [];
  const portLines = selectedInfo.ports.map(p =>
    p.host
      ? `${p.host} → ${p.container}/${p.protocol}`
      : `(not bound) ${p.container}/${p.protocol}`,
  );
  if (portLines.length) lists.push({ label: 'Ports', items: portLines });

  const volumeLines = selectedInfo.volumes.map(v =>
    `${v.source || '(anonymous)'} → ${v.destination} [${v.mode}]`,
  );
  if (volumeLines.length) lists.push({ label: 'Volumes', items: volumeLines });

  if (selectedInfo.env.length) {
    // Showing the first ~40 env vars is enough for a quick sanity check;
    // a container with thousands shouldn't overflow the editor.
    const shown = selectedInfo.env.slice(0, 40);
    const extra = selectedInfo.env.length - shown.length;
    const items = shown.slice();
    if (extra > 0) items.push(`… (+${extra} more — see docker inspect for full list)`);
    lists.push({ label: 'Environment', items });
  }

  return {
    banner: selectedInfo.state === 'running'
      ? { kind: 'running', text: 'Container is running.' }
      : { kind: 'stopped', text: `Container is ${selectedInfo.state}.` },
    rows,
    lists,
  };
}

function humanDate(iso: string): string {
  if (!iso) return '(unknown)';
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}
