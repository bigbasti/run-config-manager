import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseDotEnv, loadEnvFiles, looksLikeSecret } from '../src/services/EnvFileLoader';

describe('parseDotEnv', () => {
  test('parses simple KEY=value pairs', () => {
    expect(parseDotEnv('FOO=bar\nBAZ=qux\n')).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('strips inline comments only when preceded by whitespace', () => {
    expect(parseDotEnv('A=hello # trailing comment\nB=value#nocomment')).toEqual({
      A: 'hello',
      B: 'value#nocomment',
    });
  });

  test('skips full-line comments and blank lines', () => {
    expect(parseDotEnv('# comment\n\nFOO=1\n  # also a comment')).toEqual({ FOO: '1' });
  });

  test('honors leading export', () => {
    expect(parseDotEnv('export FOO=bar')).toEqual({ FOO: 'bar' });
  });

  test('strips double quotes and processes \\n / \\t / \\" escapes', () => {
    expect(parseDotEnv('A="hello\\nworld"\nB="tab\\there"\nC="say \\"hi\\""'))
      .toEqual({ A: 'hello\nworld', B: 'tab\there', C: 'say "hi"' });
  });

  test('treats single quotes as literal (no escape processing)', () => {
    expect(parseDotEnv("A='hello\\nworld'")).toEqual({ A: 'hello\\nworld' });
  });

  test('rejects invalid keys', () => {
    expect(parseDotEnv('1FOO=x\nFOO BAR=y\n2=z')).toEqual({});
  });

  test('does not expand ${OTHER}', () => {
    expect(parseDotEnv('A=${HOME}/x')).toEqual({ A: '${HOME}/x' });
  });

  test('lines without `=` are ignored', () => {
    expect(parseDotEnv('garbage line\nFOO=ok')).toEqual({ FOO: 'ok' });
  });

  test('strips BOM at start of file', () => {
    expect(parseDotEnv('﻿FOO=bar')).toEqual({ FOO: 'bar' });
  });

  test('preserves trailing whitespace inside double quotes', () => {
    expect(parseDotEnv('A="trailing   "')).toEqual({ A: 'trailing   ' });
  });
});

describe('loadEnvFiles', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'rcm-env-'));
  });
  afterEach(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  test('loads a single file relative to workspace folder', async () => {
    await fs.promises.writeFile(path.join(tmp, '.env'), 'FOO=bar\nBAZ=qux\n');
    const r = await loadEnvFiles(['.env'], tmp);
    expect(r.files).toHaveLength(1);
    expect(r.files[0].loaded).toBe(true);
    expect(r.files[0].variables).toEqual({ FOO: 'bar', BAZ: 'qux' });
    expect(r.merged).toEqual({ FOO: 'bar', BAZ: 'qux' });
  });

  test('later files override earlier ones in merged map', async () => {
    await fs.promises.writeFile(path.join(tmp, 'a.env'), 'FOO=from-a\nKEEP=a\n');
    await fs.promises.writeFile(path.join(tmp, 'b.env'), 'FOO=from-b\nNEW=b\n');
    const r = await loadEnvFiles(['a.env', 'b.env'], tmp);
    expect(r.merged).toEqual({ FOO: 'from-b', KEEP: 'a', NEW: 'b' });
  });

  test('reports missing files but keeps loading the rest', async () => {
    await fs.promises.writeFile(path.join(tmp, 'real.env'), 'A=1');
    const r = await loadEnvFiles(['nope.env', 'real.env'], tmp);
    expect(r.files[0].loaded).toBe(false);
    expect(r.files[0].error).toBe('missing');
    expect(r.files[1].loaded).toBe(true);
    expect(r.merged).toEqual({ A: '1' });
  });

  test('accepts absolute paths', async () => {
    const file = path.join(tmp, 'abs.env');
    await fs.promises.writeFile(file, 'X=y');
    const r = await loadEnvFiles([file], '/some/other/cwd');
    expect(r.files[0].resolvedPath).toBe(file);
    expect(r.files[0].loaded).toBe(true);
  });

  test('skips empty / whitespace path entries', async () => {
    const r = await loadEnvFiles(['', '   '], tmp);
    expect(r.files).toEqual([]);
    expect(r.merged).toEqual({});
  });
});

describe('looksLikeSecret', () => {
  test.each([
    'PASSWORD', 'DB_PASSWORD', 'API_TOKEN', 'GITHUB_TOKEN',
    'OAUTH_CLIENT_SECRET', 'PRIVATE_KEY', 'API_KEY',
  ])('%s is a secret', (k) => {
    expect(looksLikeSecret(k)).toBe(true);
  });

  test.each(['DEBUG', 'PORT', 'NODE_ENV', 'LOG_LEVEL'])('%s is not a secret', (k) => {
    expect(looksLikeSecret(k)).toBe(false);
  });
});
