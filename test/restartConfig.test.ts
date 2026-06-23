import { restartConfig } from '../src/services/restartConfig';
import type { RunConfig } from '../src/shared/types';

// Minimal fakes — restartConfig only reads config.id and passes folder through.
const config = { id: 'cfg-1', name: 'X' } as unknown as RunConfig;
const folder = {} as any;

interface Recorder { calls: string[] }

function makeDeps(opts: { debugging: boolean; monitoring: boolean }) {
  const rec: Recorder = { calls: [] };
  const exec = {
    stop: jest.fn(async () => { rec.calls.push('exec.stop'); }),
    run: jest.fn(async () => { rec.calls.push('exec.run'); return undefined; }),
    waitForShutdown: jest.fn(async () => { rec.calls.push('exec.waitForShutdown'); }),
  };
  const dbg = {
    isRunning: jest.fn(() => opts.debugging),
    stop: jest.fn(async () => { rec.calls.push('dbg.stop'); }),
    debug: jest.fn(async () => { rec.calls.push('dbg.debug'); return true; }),
  };
  const monitoring = {
    state: jest.fn(() => (opts.monitoring ? ({} as any) : undefined)),
  };
  return { rec, exec, dbg, monitoring };
}

describe('restartConfig', () => {
  test('normal mode: stop, wait for shutdown, restart via exec.run with no opts', async () => {
    const { rec, exec, dbg } = makeDeps({ debugging: false, monitoring: false });
    await restartConfig({ exec, dbg, settleMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['exec.stop', 'exec.waitForShutdown', 'exec.run']);
    expect(exec.run).toHaveBeenCalledWith(config, folder, undefined);
    expect(dbg.stop).not.toHaveBeenCalled();
  });

  test('debug mode: stop, wait, restart via debug, no monitor opt', async () => {
    const { rec, exec, dbg } = makeDeps({ debugging: true, monitoring: false });
    await restartConfig({ exec, dbg, settleMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['dbg.stop', 'exec.waitForShutdown', 'dbg.debug']);
    expect(dbg.debug).toHaveBeenCalledWith(config, folder, undefined);
    expect(exec.stop).not.toHaveBeenCalled();
  });

  test('monitored mode: restart via exec.run with monitor opt', async () => {
    const { rec, exec, monitoring, dbg } = makeDeps({ debugging: false, monitoring: true });
    await restartConfig({ exec, dbg, monitoring, settleMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['exec.stop', 'exec.waitForShutdown', 'exec.run']);
    expect(exec.run).toHaveBeenCalledWith(config, folder, { monitor: true });
  });

  test('debug + monitored: restart via debug with monitor opt', async () => {
    const { rec, exec, dbg, monitoring } = makeDeps({ debugging: true, monitoring: true });
    await restartConfig({ exec, dbg, monitoring, settleMs: 0 } as any, config, folder);
    expect(rec.calls).toEqual(['dbg.stop', 'exec.waitForShutdown', 'dbg.debug']);
    expect(dbg.debug).toHaveBeenCalledWith(config, folder, { monitor: true });
  });

  test('waits for shutdown (port release + settle) AFTER stop, BEFORE restart', async () => {
    const { rec, exec, dbg } = makeDeps({ debugging: false, monitoring: false });
    await restartConfig({ exec, dbg, settleMs: 0 } as any, config, folder);
    expect(exec.waitForShutdown).toHaveBeenCalledWith(config, folder, 0);
    // stop precedes waitForShutdown precedes run.
    expect(rec.calls.indexOf('exec.stop')).toBeLessThan(rec.calls.indexOf('exec.waitForShutdown'));
    expect(rec.calls.indexOf('exec.waitForShutdown')).toBeLessThan(rec.calls.indexOf('exec.run'));
  });

  test('mode is captured BEFORE stop (isRunning queried up front)', async () => {
    const { dbg, exec } = makeDeps({ debugging: true, monitoring: false });
    await restartConfig({ exec, dbg, settleMs: 0 } as any, config, folder);
    expect(dbg.isRunning).toHaveBeenCalledWith('cfg-1');
  });
});
