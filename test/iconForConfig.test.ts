import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Uri } from 'vscode';
import { iconForConfig } from '../src/ui/iconForConfig';
import type { RunConfig } from '../src/shared/types';

// iconForConfig reads the project's package.json + various framework config
// files from the real filesystem. We build fixtures in a tempdir and have
// the adapter read from there. WeakMap cache means each config fixture
// needs a fresh object.

const TMPROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-icons-'));
const EXTENSION_URI = Uri.file('/ext');

// iconForConfig returns Uri | { light, dark } depending on whether the
// brand needs a light-theme variant. Tests that don't care about the
// variant just assert against the dark path, which is always present.
function darkPath(v: Uri | { light: Uri; dark: Uri }): string {
  return 'fsPath' in v ? v.fsPath : v.dark.fsPath;
}

function workspace(name: string) {
  const root = path.join(TMPROOT, name);
  fs.mkdirSync(root, { recursive: true });
  return { folder: { uri: Uri.file(root), name, index: 0 }, root };
}

function npmCfg(scriptName: string, projectPath = ''): RunConfig {
  return {
    id: `id-${scriptName}-${projectPath}`,
    name: 'x',
    type: 'npm',
    projectPath,
    workspaceFolder: '',
    env: {},
    programArgs: '',
    vmArgs: '',
    typeOptions: { scriptName, packageManager: 'npm' },
  };
}

describe('iconForConfig: explicit type mappings', () => {
  const { folder } = workspace('typemap');

  test('spring-boot → spring-boot.svg', () => {
    const cfg: RunConfig = {
      id: 'sb', name: 'x', type: 'spring-boot', projectPath: '', workspaceFolder: '',
      env: {}, programArgs: '', vmArgs: '',
      typeOptions: {
        launchMode: 'maven', buildTool: 'maven', gradleCommand: './gradlew',
        profiles: '', mainClass: '', classpath: '', jdkPath: '', module: '',
        gradlePath: '', mavenPath: '', buildRoot: '',
      },
    };
    const uri = iconForConfig(cfg, folder as any, EXTENSION_URI);
    expect(darkPath(uri)).toMatch(/spring-boot\.svg$/);
  });

  test('tomcat / quarkus / java / maven-goal / gradle-task map to brand icons', () => {
    const checks: Array<[RunConfig['type'], string]> = [
      ['tomcat', 'tomcat'],
      ['quarkus', 'quarkus'],
      ['java', 'java'],
      ['maven-goal', 'maven'],
      ['gradle-task', 'gradle'],
      ['custom-command', 'bash'],
    ];
    for (const [type, brand] of checks) {
      const cfg = { id: type, name: 'x', type, projectPath: '', workspaceFolder: '',
        env: {}, programArgs: '', vmArgs: '', typeOptions: {} } as any;
      expect(darkPath(iconForConfig(cfg, folder as any, EXTENSION_URI))).toMatch(new RegExp(`${brand}\\.svg$`));
    }
  });
});

describe('iconForConfig: npm sub-type detection by config-file', () => {
  test('angular.json → angular.svg', () => {
    const { folder, root } = workspace('angular-byfile');
    fs.writeFileSync(path.join(root, 'angular.json'), '{}');
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"start":"ng serve"}}');
    expect(darkPath(iconForConfig(npmCfg('start'), folder as any, EXTENSION_URI)))
      .toMatch(/angular\.svg$/);
  });

  test('next.config.js → nextjs.svg', () => {
    const { folder, root } = workspace('next-byfile');
    fs.writeFileSync(path.join(root, 'next.config.js'), 'module.exports = {}');
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"dev":"next dev"}}');
    expect(darkPath(iconForConfig(npmCfg('dev'), folder as any, EXTENSION_URI)))
      .toMatch(/nextjs\.svg$/);
  });

  test('vite.config.ts → vite.svg', () => {
    const { folder, root } = workspace('vite-byfile');
    fs.writeFileSync(path.join(root, 'vite.config.ts'), 'export default {}');
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"dev":"vite"}}');
    expect(darkPath(iconForConfig(npmCfg('dev'), folder as any, EXTENSION_URI)))
      .toMatch(/vite\.svg$/);
  });

  test('svelte.config.js → svelte.svg', () => {
    const { folder, root } = workspace('svelte-byfile');
    fs.writeFileSync(path.join(root, 'svelte.config.js'), 'export default {}');
    fs.writeFileSync(path.join(root, 'package.json'), '{"scripts":{"dev":"svelte-kit dev"}}');
    expect(darkPath(iconForConfig(npmCfg('dev'), folder as any, EXTENSION_URI)))
      .toMatch(/svelte\.svg$/);
  });
});

describe('iconForConfig: npm sub-type detection by script content', () => {
  test('script invokes ng → angular', () => {
    const { folder, root } = workspace('ng-byscript');
    // No angular.json — only the script line gives it away.
    fs.writeFileSync(path.join(root, 'package.json'),
      '{"scripts":{"start":"ng serve --host 0.0.0.0"}}');
    expect(darkPath(iconForConfig(npmCfg('start'), folder as any, EXTENSION_URI)))
      .toMatch(/angular\.svg$/);
  });

  test('script invokes react-scripts → react', () => {
    const { folder, root } = workspace('react-byscript');
    fs.writeFileSync(path.join(root, 'package.json'),
      '{"scripts":{"start":"react-scripts start"}}');
    expect(darkPath(iconForConfig(npmCfg('start'), folder as any, EXTENSION_URI)))
      .toMatch(/react\.svg$/);
  });

  test('plain "node dist/app.js" → node', () => {
    const { folder, root } = workspace('node-byscript');
    fs.writeFileSync(path.join(root, 'package.json'),
      '{"scripts":{"start":"node dist/app.js"}}');
    expect(darkPath(iconForConfig(npmCfg('start'), folder as any, EXTENSION_URI)))
      .toMatch(/node\.svg$/);
  });

  test('nodemon → node', () => {
    const { folder, root } = workspace('nodemon-byscript');
    fs.writeFileSync(path.join(root, 'package.json'),
      '{"scripts":{"dev":"nodemon src/index.ts"}}');
    expect(darkPath(iconForConfig(npmCfg('dev'), folder as any, EXTENSION_URI)))
      .toMatch(/node\.svg$/);
  });
});

describe('iconForConfig: npm sub-type detection by dependency', () => {
  test('falls back to @angular/core dependency when config file is missing', () => {
    const { folder, root } = workspace('angular-bydep');
    fs.writeFileSync(path.join(root, 'package.json'),
      '{"scripts":{"start":"my-wrapper"},"dependencies":{"@angular/core":"17.0.0"}}');
    expect(darkPath(iconForConfig(npmCfg('start'), folder as any, EXTENSION_URI)))
      .toMatch(/angular\.svg$/);
  });
});

describe('iconForConfig: fallback to plain npm', () => {
  test('no package.json → npm.svg', () => {
    const { folder } = workspace('noconfig');
    expect(darkPath(iconForConfig(npmCfg('start'), folder as any, EXTENSION_URI)))
      .toMatch(/npm\.svg$/);
  });

  test('minimal package.json with no scripts → npm.svg', () => {
    const { folder, root } = workspace('minimal');
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    expect(darkPath(iconForConfig(npmCfg('start'), folder as any, EXTENSION_URI)))
      .toMatch(/npm\.svg$/);
  });
});

describe('iconForConfig: light/dark theme variants', () => {
  const { folder } = workspace('themevariant');

  test('java returns { light, dark } — java icon is too dark for dark themes', () => {
    const cfg = { id: 'j', name: 'x', type: 'java', projectPath: '', workspaceFolder: '',
      env: {}, programArgs: '', vmArgs: '', typeOptions: {} } as any;
    const v = iconForConfig(cfg, folder as any, EXTENSION_URI);
    expect('light' in v).toBe(true);
    if ('light' in v) {
      expect(v.light.fsPath).toMatch(/java-light\.svg$/);
      expect(v.dark.fsPath).toMatch(/java\.svg$/);
    }
  });

  test('spring-boot now also returns a {light, dark} pair — every brand is mono-themed', () => {
    // Used to keep brand colour because the green read on both themes,
    // but the user reported coloured icons made running configs hard to
    // spot (running state itself signals with green). All brands now
    // render gray-on-dark / dark-gray-on-light, so each brand returns
    // the {light, dark} pair.
    const cfg = { id: 'sb', name: 'x', type: 'spring-boot', projectPath: '', workspaceFolder: '',
      env: {}, programArgs: '', vmArgs: '', typeOptions: {} } as any;
    const v = iconForConfig(cfg, folder as any, EXTENSION_URI);
    expect('light' in v).toBe(true);
    if ('light' in v) {
      expect(v.light.fsPath).toMatch(/spring-boot-light\.svg$/);
      expect(v.dark.fsPath).toMatch(/spring-boot\.svg$/);
    }
  });
});

describe('iconForConfig: projectPath is honored', () => {
  test('sub-directory package.json takes precedence over workspace root', () => {
    const { folder, root } = workspace('monorepo');
    fs.mkdirSync(path.join(root, 'web'), { recursive: true });
    fs.writeFileSync(path.join(root, 'web', 'angular.json'), '{}');
    fs.writeFileSync(path.join(root, 'web', 'package.json'),
      '{"scripts":{"start":"ng serve"}}');
    expect(darkPath(iconForConfig(npmCfg('start', 'web'), folder as any, EXTENSION_URI)))
      .toMatch(/angular\.svg$/);
  });
});
