import {
  readyPatternsFor,
  chunkSignalsReady,
  failurePatternsFor,
  chunkSignalsFailure,
} from '../src/services/readyPatterns';
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

  test('Quarkus: Listening on: http://...', () => {
    const patterns = readyPatternsFor(cfg({ type: 'quarkus' } as any));
    expect(chunkSignalsReady(
      '__  ____  __  _____   ___  __ ____  ______\nListening on: http://0.0.0.0:8080',
      patterns,
    )).toBe(true);
    expect(chunkSignalsReady('Listening on:  http://localhost:8080', patterns)).toBe(true);
  });

  test('Quarkus: Profile dev activated. Live Coding activated.', () => {
    const patterns = readyPatternsFor(cfg({ type: 'quarkus' } as any));
    expect(chunkSignalsReady('Profile dev activated. Live Coding activated.', patterns)).toBe(true);
  });

  test('Quarkus: no false positive on build noise', () => {
    const patterns = readyPatternsFor(cfg({ type: 'quarkus' } as any));
    expect(chunkSignalsReady('> Task :compileJava', patterns)).toBe(false);
    expect(chunkSignalsReady('[INFO] BUILD SUCCESS', patterns)).toBe(false);
  });
});

describe('failurePatternsFor', () => {
  test('Spring Boot: APPLICATION FAILED TO START banner', () => {
    const patterns = failurePatternsFor(cfg({ type: 'spring-boot' }));
    expect(chunkSignalsFailure(
      '***************************\nAPPLICATION FAILED TO START\n***************************',
      patterns,
    )).toBe(true);
  });

  test('Spring Boot: Web server failed to start', () => {
    const patterns = failurePatternsFor(cfg({ type: 'spring-boot' }));
    expect(chunkSignalsFailure('Web server failed to start. Port 8080 was already in use.', patterns)).toBe(true);
  });

  test('Spring Boot: Gradle BUILD FAILED', () => {
    const patterns = failurePatternsFor(cfg({ type: 'spring-boot' }));
    expect(chunkSignalsFailure('BUILD FAILED in 3s', patterns)).toBe(true);
  });

  test('Tomcat: BindException', () => {
    const patterns = failurePatternsFor(cfg({ type: 'tomcat' }));
    expect(chunkSignalsFailure(
      'Caused by: java.net.BindException: Address already in use',
      patterns,
    )).toBe(true);
  });

  test('Tomcat: context startup failed', () => {
    const patterns = failurePatternsFor(cfg({ type: 'tomcat' }));
    expect(chunkSignalsFailure(
      'Context [/api] startup failed due to previous errors',
      patterns,
    )).toBe(true);
  });

  test('npm: Angular bundle generation failed', () => {
    const patterns = failurePatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsFailure('✘ Application bundle generation failed. [2.345 seconds]', patterns)).toBe(true);
  });

  test('npm: EADDRINUSE', () => {
    const patterns = failurePatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsFailure('Error: listen EADDRINUSE: address already in use :::3000', patterns)).toBe(true);
  });

  test('npm: npm ERR!', () => {
    const patterns = failurePatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsFailure('npm ERR! Missing script: "stort"', patterns)).toBe(true);
  });

  test('no false positive on happy-path log lines', () => {
    const sb = failurePatternsFor(cfg({ type: 'spring-boot' }));
    expect(chunkSignalsFailure('INFO  Started DdsSWebApiApplication in 8.1 seconds', sb)).toBe(false);
    expect(chunkSignalsFailure('BUILD SUCCESSFUL in 4s', sb)).toBe(false);
    const npm = failurePatternsFor(cfg({ type: 'npm' } as any));
    expect(chunkSignalsFailure('✔ Compiled successfully.', npm)).toBe(false);
  });

  test('unknown type returns empty failure patterns', () => {
    expect(failurePatternsFor({ type: 'unknown' } as any)).toEqual([]);
  });

  test('Quarkus: Failed to start application', () => {
    const patterns = failurePatternsFor(cfg({ type: 'quarkus' } as any));
    expect(chunkSignalsFailure('ERROR [io.quarkus] Failed to start application', patterns)).toBe(true);
    expect(chunkSignalsFailure('Failed to start quarkus: ...', patterns)).toBe(true);
  });

  test('Quarkus: Port already in use', () => {
    const patterns = failurePatternsFor(cfg({ type: 'quarkus' } as any));
    expect(chunkSignalsFailure('Port 8080 is already in use', patterns)).toBe(true);
  });

  test('Quarkus: Gradle BUILD FAILED', () => {
    const patterns = failurePatternsFor(cfg({ type: 'quarkus' } as any));
    expect(chunkSignalsFailure('BUILD FAILED in 4s', patterns)).toBe(true);
  });
});
