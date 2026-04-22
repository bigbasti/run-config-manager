import { makePrettifier } from '../src/services/prettyOutput';
import type { RunConfig } from '../src/shared/types';

function cfg(overrides: Partial<RunConfig>): RunConfig {
  return { type: 'spring-boot', ...overrides } as RunConfig;
}

const ESC = '\x1b';
const BEL = '\x07';
const OSC_LINK_START = `${ESC}]8;;`;
const OSC_LINK_END = `${ESC}]8;;${BEL}`;

describe('prettifier: line buffering', () => {
  test('holds trailing fragment across chunks', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    expect(p.process('Starting')).toBe('');
    const out = p.process(' up\n');
    expect(out).toContain('Starting up');
  });

  test('flush emits buffered partial line', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    p.process('no newline');
    expect(p.flush()).toContain('no newline');
    expect(p.flush()).toBe('');
  });
});

describe('prettifier: ready/fail markers', () => {
  test('prefixes green checkmark on ready line', () => {
    const p = makePrettifier(cfg({ type: 'spring-boot' }), { cwd: '/ws' });
    const out = p.process('Started MyApp in 4.2 seconds\n');
    expect(out).toMatch(/\x1b\[1;92m✓\x1b\[0m Started MyApp/);
  });

  test('prefixes red cross on failure line', () => {
    const p = makePrettifier(cfg({ type: 'spring-boot' }), { cwd: '/ws' });
    const out = p.process('APPLICATION FAILED TO START\n');
    expect(out).toMatch(/\x1b\[1;91m✗\x1b\[0m APPLICATION FAILED TO START/);
  });

  test('failure marker wins over ready on same line (implausible but defensive)', () => {
    const p = makePrettifier(cfg({ type: 'spring-boot' }), { cwd: '/ws' });
    // Contrived: "Started ... APPLICATION FAILED TO START"
    const out = p.process('Started X in 1 seconds and APPLICATION FAILED TO START\n');
    expect(out).toMatch(/✗/);
    expect(out).not.toMatch(/✓/);
  });
});

describe('prettifier: level coloring on plain lines', () => {
  test('colors ERROR red and dims timestamp', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    const out = p.process('2026-04-22 14:30:01.123 ERROR something broke\n');
    expect(out).toContain(`\x1b[2m2026-04-22 14:30:01.123\x1b[0m`);
    expect(out).toContain(`\x1b[91mERROR\x1b[0m`);
  });

  test('colors INFO blue', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    const out = p.process('2026-04-22 14:30:01 INFO started\n');
    expect(out).toContain(`\x1b[94mINFO\x1b[0m`);
  });

  test('colors WARN yellow', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    const out = p.process('14:30:01 WARN deprecated config\n');
    expect(out).toContain(`\x1b[93mWARN\x1b[0m`);
  });

  test('leaves body alone when line already has ANSI codes', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    const preColored = `2026-04-22 14:30:01 \x1b[31mERROR\x1b[0m boom\n`;
    const out = p.process(preColored);
    // No double-coloring of ERROR — the pre-existing \x1b[31m remains, we
    // don't prepend \x1b[91m.
    expect(out).not.toContain(`\x1b[91mERROR`);
    expect(out).toContain(`\x1b[31mERROR`);
  });
});

describe('prettifier: hyperlinks', () => {
  test('wraps URLs in OSC 8 sequences', () => {
    const p = makePrettifier(cfg({ type: 'npm' } as any), { cwd: '/ws' });
    const out = p.process('Local: http://localhost:3000/\n');
    expect(out).toContain(`${OSC_LINK_START}http://localhost:3000/${BEL}http://localhost:3000/${OSC_LINK_END}`);
  });

  test('does not pull trailing punctuation into URL', () => {
    const p = makePrettifier(cfg({ type: 'npm' } as any), { cwd: '/ws' });
    const out = p.process('See http://example.com/foo, then reload\n');
    expect(out).toContain(`;;http://example.com/foo${BEL}http://example.com/foo`);
    expect(out).not.toContain(`http://example.com/foo,`);
  });

  test('wraps absolute file paths with line numbers', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    const out = p.process('at /ws/src/App.java:42\n');
    expect(out).toContain(`${OSC_LINK_START}file:///ws/src/App.java#L42${BEL}/ws/src/App.java:42${OSC_LINK_END}`);
  });

  test('wraps relative file paths by resolving against cwd', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws/api' });
    const out = p.process('  at ./src/App.java:12:5\n');
    expect(out).toContain(`file:///ws/api/src/App.java#L12:5`);
  });

  test('does not wrap prose without a file extension', () => {
    const p = makePrettifier(cfg({}), { cwd: '/ws' });
    const out = p.process('Starting /usr/local without extension\n');
    expect(out).not.toContain(OSC_LINK_START);
  });
});
