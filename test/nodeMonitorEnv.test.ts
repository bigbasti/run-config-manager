import { buildNodeMonitorEnv } from '../src/utils/nodeMonitorEnv';

describe('buildNodeMonitorEnv', () => {
  const OLD = process.env.NODE_OPTIONS;
  afterEach(() => { if (OLD === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = OLD; });

  test('sets require + port + id when no prior NODE_OPTIONS', () => {
    delete process.env.NODE_OPTIONS;
    const env = buildNodeMonitorEnv('/x/agent.cjs', 4321, 'cfg1');
    expect(env.NODE_OPTIONS).toBe('--require "/x/agent.cjs"');
    expect(env.RCM_MONITOR_PORT).toBe('4321');
    expect(env.RCM_MONITOR_ID).toBe('cfg1');
  });

  test('preserves an existing NODE_OPTIONS', () => {
    process.env.NODE_OPTIONS = '--max-old-space-size=4096';
    const env = buildNodeMonitorEnv('/x/agent.cjs', 1, 'c');
    expect(env.NODE_OPTIONS).toBe('--max-old-space-size=4096 --require "/x/agent.cjs"');
  });
});
