import { detectNpmFrameworkFrom } from '../src/adapters/npm/detectNpmFramework';

// Helper — produces an "all signals" summary the detector consumes.
// Mirrors the shape detectNpmFramework.detect() builds at runtime
// from filesystem + package.json checks.
function makeSignals(overrides: Partial<{
  files: string[];
  dependencies: string[];
  scripts: string[];
  pkgScripts: Record<string, string>;
}> = {}) {
  return {
    files: overrides.files ?? [],
    dependencies: overrides.dependencies ?? [],
    scripts: overrides.scripts ?? [],
    pkgScripts: overrides.pkgScripts ?? {},
  };
}

describe('detectNpmFrameworkFrom — per-framework signals', () => {
  test('Next.js wins on next.config.ts even when vite.config.ts is present', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['next.config.ts', 'vite.config.ts'],
      dependencies: ['next', 'vite'],
      scripts: ['dev', 'build', 'start'],
    }));
    expect(r.name).toBe('nextjs');
    expect(r.defaultScript).toBe('dev');
    expect(r.defaultPort).toBe(3000);
    expect(r.source).toContain('next.config.ts');
  });

  test('Nuxt detected via nuxt.config.js', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['nuxt.config.js'],
      scripts: ['dev', 'build'],
    }));
    expect(r.name).toBe('nuxt');
    expect(r.defaultPort).toBe(3000);
  });

  test('SvelteKit detected via @sveltejs/kit dep — wins over generic Vite', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['vite.config.ts'],
      dependencies: ['@sveltejs/kit', 'vite'],
      scripts: ['dev'],
    }));
    expect(r.name).toBe('sveltekit');
  });

  test('Astro detected via astro.config.mjs', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['astro.config.mjs'],
      scripts: ['dev', 'build', 'preview'],
    }));
    expect(r.name).toBe('astro');
    expect(r.defaultPort).toBe(4321);
  });

  test('Remix detected via remix.config.js', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['remix.config.js'],
      scripts: ['dev'],
    }));
    expect(r.name).toBe('remix');
    expect(r.defaultPort).toBe(3000);
  });

  test('Gatsby detected via gatsby-config.js — uses develop script', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['gatsby-config.js'],
      scripts: ['develop', 'build', 'serve'],
    }));
    expect(r.name).toBe('gatsby');
    expect(r.defaultScript).toBe('develop');
    expect(r.defaultPort).toBe(8000);
  });

  test('Angular detected via angular.json — uses start script', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['angular.json'],
      dependencies: ['@angular/core'],
      scripts: ['ng', 'start', 'build', 'test'],
    }));
    expect(r.name).toBe('angular');
    expect(r.defaultScript).toBe('start');
    expect(r.defaultPort).toBe(4200);
  });

  test('Storybook detected via .storybook/ dir', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['.storybook/'],
      scripts: ['storybook', 'build-storybook'],
    }));
    expect(r.name).toBe('storybook');
    expect(r.defaultScript).toBe('storybook');
    expect(r.defaultPort).toBe(6006);
  });

  test('Vue CLI detected via vue.config.js', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['vue.config.js'],
      dependencies: ['@vue/cli-service'],
      scripts: ['serve', 'build', 'lint'],
    }));
    expect(r.name).toBe('vue');
    expect(r.defaultScript).toBe('serve');
    expect(r.defaultPort).toBe(8080);
  });

  test('CRA detected via react-scripts dep', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      dependencies: ['react-scripts'],
      scripts: ['start', 'build', 'test'],
    }));
    expect(r.name).toBe('react');
    expect(r.defaultScript).toBe('start');
    expect(r.defaultPort).toBe(3000);
  });

  test('Plain Vite detected via vite.config.ts when no meta-framework matched', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['vite.config.ts'],
      dependencies: ['vite'],
      scripts: ['dev', 'build', 'preview'],
    }));
    expect(r.name).toBe('vite');
    expect(r.defaultScript).toBe('dev');
    expect(r.defaultPort).toBe(5173);
  });

  test('falls back to first script when no framework matches', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      scripts: ['build', 'test'],
    }));
    expect(r.name).toBeNull();
    expect(r.defaultScript).toBe('build');
    expect(r.defaultPort).toBeNull();
  });

  test('defaultScript falls back to scripts[0] when convention name is absent', () => {
    // Angular detected, but `start` not present in scripts — fall back.
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['angular.json'],
      scripts: ['ng', 'build'], // no `start`
    }));
    expect(r.name).toBe('angular');
    expect(r.defaultScript).toBe('ng');
  });

  test('defaultScript empty when no scripts at all', () => {
    const r = detectNpmFrameworkFrom(makeSignals({
      files: ['angular.json'],
      scripts: [],
    }));
    expect(r.defaultScript).toBe('');
  });
});
