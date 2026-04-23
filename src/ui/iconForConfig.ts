import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';

// Brands whose canonical simple-icons color is too dark to read on a VS
// Code dark theme (pure black Java/Angular/Next.js, dark teal Gradle).
// For these, the generator emits a `-light.svg` sibling tinted with the
// original color, and we return {light, dark} pairs so VS Code picks the
// right one per active theme.
const BRANDS_WITH_LIGHT_VARIANT = new Set(['java', 'angular', 'nextjs', 'gradle']);

// Builds the Uri (or {light, dark} pair) for a brand name. Exported so
// tree-group headers and individual config rows share the same theme logic.
export function brandIconUri(
  brand: string,
  extensionUri: vscode.Uri,
): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
  const dark = vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${brand}.svg`);
  if (BRANDS_WITH_LIGHT_VARIANT.has(brand)) {
    const light = vscode.Uri.joinPath(extensionUri, 'media', 'icons', `${brand}-light.svg`);
    return { light, dark };
  }
  return dark;
}

// Maps a config to the brand SVG under media/icons/. For npm configs we
// sniff package.json scripts + tell-tale files (angular.json, vite.config.*,
// next.config.*, svelte.config.*) to pick a more specific framework icon.
//
// Sniffing is synchronous + cached per config id to keep tree rendering
// fast. The cache is invalidated when the config object identity changes
// (ConfigStore rebuilds configurations on every file edit).
export function iconForConfig(
  cfg: RunConfig,
  workspaceFolder: vscode.WorkspaceFolder | undefined,
  extensionUri: vscode.Uri,
): vscode.Uri | { light: vscode.Uri; dark: vscode.Uri } {
  return brandIconUri(brandFor(cfg, workspaceFolder), extensionUri);
}

const PER_CONFIG_CACHE = new WeakMap<RunConfig, string>();

function brandFor(cfg: RunConfig, folder: vscode.WorkspaceFolder | undefined): string {
  const cached = PER_CONFIG_CACHE.get(cfg);
  if (cached) return cached;
  const resolved = computeBrand(cfg, folder);
  PER_CONFIG_CACHE.set(cfg, resolved);
  return resolved;
}

function computeBrand(cfg: RunConfig, folder: vscode.WorkspaceFolder | undefined): string {
  switch (cfg.type) {
    case 'spring-boot': return 'spring-boot';
    case 'tomcat':      return 'tomcat';
    case 'quarkus':     return 'quarkus';
    case 'java':        return 'java';
    case 'maven-goal':  return 'maven';
    case 'gradle-task': return 'gradle';
    case 'custom-command': return 'bash';
    case 'npm': {
      if (!folder) return 'npm';
      const sub = detectNpmSubtype(folder.uri, cfg.projectPath, cfg.typeOptions.scriptName);
      return sub ?? 'npm';
    }
  }
}

// Cheap synchronous probe: readFileSync on package.json + existsSync on a
// handful of config-file names. Invoked in the tree render path so must
// return in single-digit ms even on cold cache. Missing workspace files
// just fall through to the default 'npm' icon.
function detectNpmSubtype(
  workspaceUri: vscode.Uri,
  projectPath: string,
  scriptName: string,
): string | null {
  // Resolve project root synchronously — no URI helpers that might go async.
  const fs = require('fs') as typeof import('fs');
  const path = require('path') as typeof import('path');
  const projectRoot = path.join(workspaceUri.fsPath, projectPath || '');

  const has = (file: string): boolean => {
    try { return fs.existsSync(path.join(projectRoot, file)); } catch { return false; }
  };

  // Config-file tell-tales first — they're the most deterministic signal.
  if (has('angular.json')) return 'angular';
  // Next.js often coexists with a vite.config in monorepos, so check it first.
  if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) return 'nextjs';
  if (has('svelte.config.js') || has('svelte.config.ts')) return 'svelte';
  if (has('vite.config.js') || has('vite.config.ts') || has('vite.config.mjs')) return 'vite';
  if (has('vue.config.js')) return 'vue';

  // Fallback: inspect package.json scripts for framework-specific CLI
  // invocations. Only useful when the config file was renamed / omitted.
  let scripts: Record<string, string> | null = null;
  try {
    const raw = fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    scripts = pkg.scripts ?? null;

    // One more layer: look at the specific script the user picked. "ng
    // serve" / "next dev" / "vite" are unambiguous.
    const line = scripts?.[scriptName] ?? '';
    if (/\bng\b/.test(line)) return 'angular';
    if (/\bnext\b/.test(line)) return 'nextjs';
    if (/\bvite\b/.test(line)) return 'vite';
    if (/\bvue-cli-service\b/.test(line)) return 'vue';
    if (/\bsvelte-kit\b|\bsveltekit\b/.test(line)) return 'svelte';
    if (/\breact-scripts\b/.test(line)) return 'react';

    // Last resort: scan dependencies. Cheaper than nothing, noisier than the
    // other signals because a library project can depend on react without
    // being a react app.
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    if ('@angular/core' in deps) return 'angular';
    if ('next' in deps) return 'nextjs';
    if ('vue' in deps) return 'vue';
    if ('svelte' in deps) return 'svelte';
    if ('react' in deps) return 'react';
  } catch {
    /* no package.json or parse error — fall through to npm */
  }

  // Any script still points at node scripts directly? Use the node icon for
  // plain Node scripts so the user can tell they're not a framework app.
  if (scripts) {
    const line = scripts[scriptName] ?? '';
    if (/^\s*node\b/.test(line) || /\bts-node(-dev)?\b/.test(line) || /\bnodemon\b/.test(line)) {
      return 'node';
    }
  }

  return null;
}
