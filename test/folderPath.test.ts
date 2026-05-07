import {
  splitFolderPath,
  joinFolderPath,
  ancestorPaths,
  isStrictDescendant,
  folderName,
  parentPath,
  deriveKnownFolders,
  isValidFolderPath,
} from '../src/shared/folderPath';

describe('folderPath helpers', () => {
  test('split + join round-trip', () => {
    const segs = splitFolderPath('Backend/API/Internal');
    expect(segs).toEqual(['Backend', 'API', 'Internal']);
    expect(joinFolderPath(segs)).toBe('Backend/API/Internal');
  });

  test('split tolerates undefined / empty', () => {
    expect(splitFolderPath(undefined)).toEqual([]);
    expect(splitFolderPath('')).toEqual([]);
  });

  test('ancestorPaths emits every prefix', () => {
    expect(ancestorPaths('A/B/C')).toEqual(['A', 'A/B', 'A/B/C']);
    expect(ancestorPaths('Solo')).toEqual(['Solo']);
    expect(ancestorPaths('')).toEqual([]);
  });

  test('isStrictDescendant', () => {
    expect(isStrictDescendant('A/B', 'A')).toBe(true);
    expect(isStrictDescendant('A/B/C', 'A')).toBe(true);
    expect(isStrictDescendant('A', 'A')).toBe(false);
    expect(isStrictDescendant('A', 'B')).toBe(false);
    // Tricky: prefix match without separator must NOT count.
    expect(isStrictDescendant('Apple', 'A')).toBe(false);
  });

  test('folderName / parentPath', () => {
    expect(folderName('A/B/C')).toBe('C');
    expect(folderName('Top')).toBe('Top');
    expect(folderName('')).toBe('');
    expect(parentPath('A/B/C')).toBe('A/B');
    expect(parentPath('Top')).toBe('');
    expect(parentPath('')).toBe('');
  });

  test('deriveKnownFolders covers every prefix', () => {
    const out = deriveKnownFolders(['Backend/API/Internal', 'Frontend', undefined, '']);
    expect(out).toEqual(['Backend', 'Backend/API', 'Backend/API/Internal', 'Frontend']);
  });

  test('isValidFolderPath', () => {
    expect(isValidFolderPath('A')).toBe(true);
    expect(isValidFolderPath('A/B')).toBe(true);
    expect(isValidFolderPath('')).toBe(false);
    expect(isValidFolderPath('   ')).toBe(false);
    expect(isValidFolderPath('/A')).toBe(false);
    expect(isValidFolderPath('A/')).toBe(false);
    expect(isValidFolderPath('A//B')).toBe(false);
    expect(isValidFolderPath('A/ /B')).toBe(false);
  });
});
