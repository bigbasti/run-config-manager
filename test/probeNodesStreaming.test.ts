import {
  readNodes,
  nodeOption,
  probeNodesStreaming,
} from '../src/adapters/npm/probeNodesStreaming';
import * as detect from '../src/adapters/npm/detectNodes';

describe('readNodes', () => {
  test('coerces string[] (legacy shape) to NodeInfo[]', () => {
    expect(readNodes(['/opt/node-20', '/opt/node-18'])).toEqual([
      { path: '/opt/node-20' }, { path: '/opt/node-18' },
    ]);
  });
  test('passes NodeInfo[] through unchanged', () => {
    const input = [{ path: '/opt/node-20', version: '20.10.0' }];
    expect(readNodes(input)).toEqual(input);
  });
  test('returns [] for non-array input', () => {
    expect(readNodes(undefined)).toEqual([]);
    expect(readNodes(null)).toEqual([]);
    expect(readNodes({})).toEqual([]);
  });
  test('drops malformed entries', () => {
    expect(readNodes([{ path: '/ok' }, { other: 'no path' }, null]))
      .toEqual([{ path: '/ok' }]);
  });
});

describe('nodeOption', () => {
  test('shows version when present', () => {
    expect(nodeOption({ path: '/opt/node-20', version: '20.10.0' })).toEqual({
      value: '/opt/node-20',
      label: '/opt/node-20 — v20.10.0',
    });
  });
  test('falls back to path when version is absent', () => {
    expect(nodeOption({ path: '/opt/node-20' })).toEqual({
      value: '/opt/node-20',
      label: '/opt/node-20',
    });
  });
});

describe('probeNodesStreaming', () => {
  test('emits paths first, then versions, and clears spinner at end', async () => {
    jest.spyOn(detect, 'detectNodes').mockResolvedValue(['/a', '/b']);
    jest.spyOn(detect, 'probeNodeVersion').mockImplementation(async p =>
      p === '/a' ? { version: '20.0.0' } : { version: '18.0.0' },
    );

    const emits: any[] = [];
    await probeNodesStreaming((p) => emits.push(p), 'npm');

    // Phase 1: paths only, no resolved.
    expect(emits[0].contextPatch.nodes).toEqual([{ path: '/a' }, { path: '/b' }]);
    expect(emits[0].defaultsPatch).toEqual({ typeOptions: { nodePath: '/a' } });
    expect(emits[0].resolved).toBeUndefined();

    // Phase 2: enriched + resolved.
    expect(emits[1].contextPatch.nodes).toEqual([
      { path: '/a', version: '20.0.0' },
      { path: '/b', version: '18.0.0' },
    ]);
    expect(emits[1].resolved).toEqual(['typeOptions.nodePath']);
  });

  test('emits a single resolved patch when no nodes found', async () => {
    jest.spyOn(detect, 'detectNodes').mockResolvedValue([]);
    const emits: any[] = [];
    await probeNodesStreaming((p) => emits.push(p), 'npm');
    // First emit: empty list, no defaults.
    expect(emits[0].contextPatch.nodes).toEqual([]);
    expect(emits[0].defaultsPatch).toBeUndefined();
    // Second emit: resolved (clears spinner).
    expect(emits[1].resolved).toEqual(['typeOptions.nodePath']);
  });
});
