import { Uri, __resetFs, __writeFs } from 'vscode';
import {
  detectSpringBootPort,
  detectQuarkusPort,
  detectNpmPort,
} from '../src/services/detectProjectPort';

const ROOT = Uri.file('/proj');

beforeEach(() => __resetFs());

describe('detectSpringBootPort', () => {
  test('returns null when no application files exist', async () => {
    expect(await detectSpringBootPort(ROOT, undefined)).toBeNull();
  });

  test('reads server.port from application.properties', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=9090\nother=x\n');
    expect(await detectSpringBootPort(ROOT, undefined)).toBe(9090);
  });

  test('reads server.port from application.yml', async () => {
    __writeFs(
      '/proj/src/main/resources/application.yml',
      'server:\n  port: 8181\nspring:\n  application:\n    name: x\n',
    );
    expect(await detectSpringBootPort(ROOT, undefined)).toBe(8181);
  });

  test('reads flat-dotted YAML form (server.port: 7070)', async () => {
    __writeFs('/proj/src/main/resources/application.yml', 'server.port: 7070\n');
    expect(await detectSpringBootPort(ROOT, undefined)).toBe(7070);
  });

  test('profile-specific file wins over plain application.properties', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=9090\n');
    __writeFs('/proj/src/main/resources/application-stu.properties', 'server.port=8282\n');
    expect(await detectSpringBootPort(ROOT, 'stu')).toBe(8282);
  });

  test('falls back to plain file when profile file has no port', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=9090\n');
    __writeFs('/proj/src/main/resources/application-stu.properties', 'db.url=jdbc\n');
    expect(await detectSpringBootPort(ROOT, 'stu')).toBe(9090);
  });

  test('multiple profiles: later profile wins', async () => {
    __writeFs('/proj/src/main/resources/application-dev.properties', 'server.port=8001\n');
    __writeFs('/proj/src/main/resources/application-local.properties', 'server.port=8002\n');
    expect(await detectSpringBootPort(ROOT, 'dev,local')).toBe(8002);
  });

  test('skips commented lines', async () => {
    __writeFs('/proj/src/main/resources/application.properties', '# server.port=1\nserver.port=5555\n');
    expect(await detectSpringBootPort(ROOT, undefined)).toBe(5555);
  });

  test('${PORT:8080} placeholder → uses the default', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=${PORT:8080}\n');
    expect(await detectSpringBootPort(ROOT, undefined)).toBe(8080);
  });

  test('${PORT} without default → null (we do not guess)', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=${PORT}\n');
    expect(await detectSpringBootPort(ROOT, undefined)).toBeNull();
  });
});

describe('detectQuarkusPort', () => {
  test('returns null when no application.properties', async () => {
    expect(await detectQuarkusPort(ROOT, undefined)).toBeNull();
  });

  test('reads quarkus.http.port from application.properties', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'quarkus.http.port=8181\n');
    expect(await detectQuarkusPort(ROOT, undefined)).toBe(8181);
  });

  test('profile-prefixed key wins when profile matches', async () => {
    __writeFs(
      '/proj/src/main/resources/application.properties',
      'quarkus.http.port=8080\n%dev.quarkus.http.port=9000\n',
    );
    expect(await detectQuarkusPort(ROOT, 'dev')).toBe(9000);
  });

  test('falls back to unprefixed when profile has no override', async () => {
    __writeFs(
      '/proj/src/main/resources/application.properties',
      'quarkus.http.port=8080\n%dev.foo=1\n',
    );
    expect(await detectQuarkusPort(ROOT, 'dev')).toBe(8080);
  });

  test('reads nested YAML quarkus.http.port', async () => {
    __writeFs(
      '/proj/src/main/resources/application.yml',
      'quarkus:\n  http:\n    port: 8282\n',
    );
    expect(await detectQuarkusPort(ROOT, undefined)).toBe(8282);
  });
});

describe('detectNpmPort', () => {
  test('returns null when no package.json', async () => {
    expect(await detectNpmPort(ROOT, 'start')).toBeNull();
  });

  test('scans --port in the picked script', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { start: 'vite --port 5500' },
    }));
    expect(await detectNpmPort(ROOT, 'start')).toBe(5500);
  });

  test('Angular convention default 4200 via @angular/core dep', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { start: 'ng serve' },
      dependencies: { '@angular/core': '^17' },
    }));
    expect(await detectNpmPort(ROOT, 'start')).toBe(4200);
  });

  test('Next.js convention default 3000', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { dev: 'next dev' },
      dependencies: { next: '^14' },
    }));
    expect(await detectNpmPort(ROOT, 'dev')).toBe(3000);
  });

  test('Vite convention default 5173', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { dev: 'vite' },
      devDependencies: { vite: '^5' },
    }));
    expect(await detectNpmPort(ROOT, 'dev')).toBe(5173);
  });

  test('plain Node script → null (no convention)', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { start: 'node server.js' },
      dependencies: { express: '^4' },
    }));
    expect(await detectNpmPort(ROOT, 'start')).toBeNull();
  });

  test('explicit --port wins over framework default', async () => {
    __writeFs('/proj/package.json', JSON.stringify({
      scripts: { start: 'ng serve --port 9999' },
      dependencies: { '@angular/core': '^17' },
    }));
    expect(await detectNpmPort(ROOT, 'start')).toBe(9999);
  });
});
