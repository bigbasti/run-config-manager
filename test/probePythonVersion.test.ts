import { parsePythonVersion } from '../src/adapters/python/probePythonVersion';

describe('parsePythonVersion', () => {
  test('strips Python prefix', () => {
    expect(parsePythonVersion('Python 3.12.1\n')).toBe('3.12.1');
  });
  test('handles trailing whitespace', () => {
    expect(parsePythonVersion('  Python 3.11.7  ')).toBe('3.11.7');
  });
  test('returns undefined for non-version output', () => {
    expect(parsePythonVersion('')).toBeUndefined();
    expect(parsePythonVersion('hello world')).toBeUndefined();
  });
  test('handles version with patch and prerelease', () => {
    expect(parsePythonVersion('Python 3.13.0a3')).toBe('3.13.0a3');
  });
});
