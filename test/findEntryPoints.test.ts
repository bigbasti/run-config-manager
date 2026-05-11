import { isMainGuardLine, splitDottedFromPath } from '../src/adapters/python/findEntryPoints';

describe('isMainGuardLine', () => {
  test('matches the canonical __main__ guard', () => {
    expect(isMainGuardLine('if __name__ == "__main__":')).toBe(true);
    expect(isMainGuardLine("if __name__ == '__main__':")).toBe(true);
  });
  test('matches with leading whitespace', () => {
    expect(isMainGuardLine('    if __name__ == "__main__":')).toBe(true);
  });
  test('does not match other lines', () => {
    expect(isMainGuardLine('print("__main__")')).toBe(false);
    expect(isMainGuardLine('# if __name__ == "__main__":')).toBe(false);
    expect(isMainGuardLine('')).toBe(false);
  });
});

describe('splitDottedFromPath', () => {
  test('converts a relative file path under projectPath into a dotted module name', () => {
    expect(splitDottedFromPath('src/mypkg/cli.py', 'src')).toBe('mypkg.cli');
    expect(splitDottedFromPath('mypkg/sub/cli.py', '')).toBe('mypkg.sub.cli');
  });
  test('handles __main__.py specially (returns the package name)', () => {
    expect(splitDottedFromPath('mypkg/__main__.py', '')).toBe('mypkg');
    expect(splitDottedFromPath('src/mypkg/__main__.py', 'src')).toBe('mypkg');
  });
});
