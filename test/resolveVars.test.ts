import { resolveVars, resolveConfig } from '../src/utils/resolveVars';

const ctx = {
  env: { FOO: 'foo-val', BAR: 'bar-val' } as any,
  workspaceFolder: '/ws',
  userHome: '/home/user',
  cwd: '/ws/api',
};

describe('resolveVars', () => {
  test('expands bare ${VAR} from env', () => {
    expect(resolveVars('-D=${FOO}', ctx).value).toBe('-D=foo-val');
  });

  test('expands ${env:VAR}', () => {
    expect(resolveVars('-D=${env:FOO}', ctx).value).toBe('-D=foo-val');
  });

  test('expands ${workspaceFolder}', () => {
    expect(resolveVars('-cp ${workspaceFolder}/lib', ctx).value).toBe('-cp /ws/lib');
  });

  test('expands ${projectPath} and ${cwd} identically', () => {
    expect(resolveVars('${projectPath}', ctx).value).toBe('/ws/api');
    expect(resolveVars('${cwd}', ctx).value).toBe('/ws/api');
  });

  test('missing variable expands to empty string and is reported', () => {
    const r = resolveVars('${MISSING}-suffix', ctx);
    expect(r.value).toBe('-suffix');
    expect(r.unresolved).toEqual(['MISSING']);
  });

  test('multiple occurrences of same missing var report once per occurrence but caller dedupes', () => {
    const r = resolveVars('${X}/${X}', ctx);
    expect(r.value).toBe('/');
    expect(r.unresolved).toEqual(['X', 'X']);
  });

  test('mixes resolved and unresolved', () => {
    const r = resolveVars('${FOO}-${GONE}-${BAR}', ctx);
    expect(r.value).toBe('foo-val--bar-val');
    expect(r.unresolved).toEqual(['GONE']);
  });
});

describe('resolveConfig', () => {
  test('deep-resolves objects and arrays, dedupes unresolved', () => {
    const input = {
      vmArgs: '-Xmx${MEM} -D=${FOO}',
      env: { X: '${MEM}' },
      list: ['${WORKSPACE:-nope}', '${FOO}'],
    };
    const r = resolveConfig(input, ctx);
    expect(r.value.vmArgs).toBe('-Xmx -D=foo-val');
    expect(r.value.env.X).toBe('');
    expect(r.unresolved).toEqual(['MEM', 'WORKSPACE:-nope']);
  });

  test('leaves non-strings alone', () => {
    const r = resolveConfig({ port: 8080, ok: true, list: [1, 2, 3] }, ctx);
    expect(r.value.port).toBe(8080);
    expect(r.value.ok).toBe(true);
    expect(r.value.list).toEqual([1, 2, 3]);
  });
});
