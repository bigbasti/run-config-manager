import * as os from 'os';
import { RunTerminal } from '../src/services/RunTerminal';

// We don't have an in-tree way to mock child_process, so these tests
// drive RunTerminal end-to-end with a real child. Each test runs a
// trivial command (`true` / `echo …` / `sleep …`) so the suite stays
// fast. Linux + macOS shells; on Windows we'd need cmd-equivalents
// but the project's CI is Unix-only today.

const isWin = os.platform() === 'win32';
const noopShellCmd = isWin ? 'cmd' : 'true';
const noopShellArgs = isWin ? ['/c', 'rem'] : [];

function makeTerminal(opts: { keepOpenOnExit?: boolean; cmd?: string; args?: string[] } = {}) {
  const written: string[] = [];
  let closeCode: number | undefined;
  let exitArgs: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const term = new RunTerminal({
    command: opts.cmd ?? noopShellCmd,
    args: opts.args ?? noopShellArgs,
    cwd: process.cwd(),
    env: process.env,
    keepOpenOnExit: opts.keepOpenOnExit,
    onExit: (code, signal) => { exitArgs = { code, signal }; },
  });
  term.onDidWrite(s => written.push(s));
  term.onDidClose(c => { closeCode = (c as number) ?? 0; });
  return { term, written, get closeCode() { return closeCode; }, get exitArgs() { return exitArgs; } };
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('waitFor timeout'));
      setTimeout(tick, 20);
    };
    tick();
  });
}

describe('RunTerminal — keepOpenOnExit', () => {
  test('default behavior: terminal closes when child exits', async () => {
    const t = makeTerminal();
    t.term.open(undefined);
    await waitFor(() => t.closeCode !== undefined);
    expect(t.exitArgs).toBeDefined();
    expect(t.closeCode).toBe(0);
  });

  test('keepOpenOnExit=true: terminal LINGERS after child exits — onExit fires but closeEmitter does not', async () => {
    const t = makeTerminal({ keepOpenOnExit: true });
    t.term.open(undefined);
    // onExit is the signal that the child exited.
    await waitFor(() => t.exitArgs !== undefined);
    // Give VS Code a moment to fire close; it shouldn't.
    await new Promise(r => setTimeout(r, 50));
    expect(t.closeCode).toBeUndefined();
    // Linger banner is written so the user sees how to dismiss.
    expect(t.written.join('')).toMatch(/key press|Press any key|key to close/i);
  });

  test('keepOpenOnExit=true: any keystroke after exit dismisses the terminal', async () => {
    const t = makeTerminal({ keepOpenOnExit: true });
    t.term.open(undefined);
    await waitFor(() => t.exitArgs !== undefined);
    expect(t.closeCode).toBeUndefined();
    // Any character does it. VS Code feeds typed characters via
    // handleInput.
    t.term.handleInput('q');
    await waitFor(() => t.closeCode !== undefined);
    expect(t.closeCode).toBe(0);
  });

  test('keepOpenOnExit=true: VS Code closing the terminal (close()) after exit completes the lifecycle', async () => {
    const t = makeTerminal({ keepOpenOnExit: true });
    t.term.open(undefined);
    await waitFor(() => t.exitArgs !== undefined);
    expect(t.closeCode).toBeUndefined();
    // VS Code calls close() when the user clicks the trash icon.
    // While lingering, that should fire closeEmitter (no kill needed
    // — the child is already gone).
    t.term.close();
    await waitFor(() => t.closeCode !== undefined);
    expect(t.closeCode).toBe(0);
  });
});
