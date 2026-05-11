import { parseProcfilePort, defaultPortForFramework } from '../src/adapters/python/detectPythonPort';

describe('parseProcfilePort', () => {
  test('extracts --port from a uvicorn line', () => {
    expect(parseProcfilePort('web: uvicorn app:main --port 9000')).toBe(9000);
  });
  test('extracts -p from a flask line', () => {
    expect(parseProcfilePort('web: flask run -p 7000')).toBe(7000);
  });
  test('extracts port from gunicorn -b 0.0.0.0:N', () => {
    expect(parseProcfilePort('web: gunicorn app:app -b 0.0.0.0:8500')).toBe(8500);
  });
  test('returns undefined when no port is present', () => {
    expect(parseProcfilePort('web: celery worker')).toBeUndefined();
    expect(parseProcfilePort('')).toBeUndefined();
  });
});

describe('defaultPortForFramework', () => {
  test('django defaults to 8000', () => {
    expect(defaultPortForFramework('django')).toBe(8000);
  });
  test('flask defaults to 5000', () => {
    expect(defaultPortForFramework('flask')).toBe(5000);
  });
  test('celery has no port', () => {
    expect(defaultPortForFramework('celery')).toBeUndefined();
  });
  test('empty framework has no port', () => {
    expect(defaultPortForFramework('')).toBeUndefined();
  });
});
