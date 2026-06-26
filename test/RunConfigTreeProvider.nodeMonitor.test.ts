import { computeNodeRowExtras } from '../src/ui/RunConfigTreeProvider';
import type { RunConfig } from '../src/shared/types';

function npm(scriptName: string): RunConfig {
  return { id: 'cfg1', name: 'web', type: 'npm', projectPath: '', workspaceFolder: '',
    typeOptions: { scriptName, packageManager: 'npm', nodePath: '' } } as RunConfig;
}

describe('computeNodeRowExtras', () => {
  test('no node state → no suffix, no description', () => {
    const r = computeNodeRowExtras(npm('dev'), undefined);
    expect(r.monitored).toBe('');
    expect(r.description).toBe('');
  });

  test('formats RSS MB and CPU% from node state, sets :monitored', () => {
    const state = { status: 'live', history: [{ rss: 134217728, cpuPercent: 3.2 }] } as any;
    const r = computeNodeRowExtras(npm('dev'), state);
    expect(r.monitored).toBe(':monitored');
    expect(r.description).toBe('128 MB · 3.2%');
  });

  test('no description when no history yet (still :monitored while connecting)', () => {
    const state = { status: 'connecting', history: [] } as any;
    const r = computeNodeRowExtras(npm('dev'), state);
    expect(r.monitored).toBe(':monitored');
    expect(r.description).toBe('');
  });
});
