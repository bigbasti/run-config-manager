import { readyPatternsFor, chunkSignalsReady } from '../src/services/readyPatterns';
import type { RunConfig } from '../src/shared/types';

function cfg(overrides: Partial<RunConfig>): RunConfig {
  return { type: 'spring-boot', ...overrides } as RunConfig;
}

describe('readyPatternsFor', () => {
  test('Spring Boot: Started <AppName> in', () => {
    const patterns = readyPatternsFor(cfg({ type: 'spring-boot' }));
    expect(chunkSignalsReady('Started DdsSWebApiApplication in 8.123 seconds', patterns)).toBe(true);
  });

  test('Spring Boot: Tomcat started on port', () => {
    const patterns = readyPatternsFor(cfg({ type: 'spring-boot' }));
    expect(chunkSignalsReady('Tomcat started on port: 8181 (http)', patterns)).toBe(true);
    expect(chunkSignalsReady('Tomcat started on port 8080', patterns)).toBe(true);
  });

  test('Tomcat: Server startup in [N] ms', () => {
    const patterns = readyPatternsFor(cfg({ type: 'tomcat' }));
    expect(chunkSignalsReady('INFO  Server startup in [4224] milliseconds', patterns)).toBe(true);
    expect(chunkSignalsReady('Server startup in 1234 ms', patterns)).toBe(true);
  });

  test('npm: Angular Compiled successfully', () => {
    const patterns = readyPatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsReady('✔ Compiled successfully.', patterns)).toBe(true);
  });

  test('npm: Vite ready in Nms', () => {
    const patterns = readyPatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsReady('  VITE v5.0.0  ready in 324 ms', patterns)).toBe(true);
  });

  test('npm: webpack compiled', () => {
    const patterns = readyPatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsReady('webpack 5.89.0 compiled successfully in 2.3s', patterns)).toBe(true);
  });

  test('npm: generic listening', () => {
    const patterns = readyPatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsReady('Server listening on port 3000', patterns)).toBe(true);
    expect(chunkSignalsReady('App is running on http://localhost:3000', patterns)).toBe(true);
  });

  test('no false positive on generic log lines', () => {
    const patterns = readyPatternsFor(cfg({ type: 'spring-boot' }));
    expect(chunkSignalsReady('INFO  Starting Tomcat', patterns)).toBe(false);
    expect(chunkSignalsReady('DEBUG  Creating bean', patterns)).toBe(false);
  });

  test('unknown type returns empty patterns', () => {
    const patterns = readyPatternsFor({ type: 'unknown' } as any);
    expect(patterns).toEqual([]);
    expect(chunkSignalsReady('anything', patterns)).toBe(false);
  });
});
