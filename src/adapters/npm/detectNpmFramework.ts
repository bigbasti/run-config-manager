import * as vscode from 'vscode';
import { log } from '../../utils/logger';

export type NpmFramework =
  | 'angular' | 'nextjs' | 'nuxt' | 'vite' | 'sveltekit' | 'svelte'
  | 'vue' | 'react' | 'astro' | 'remix' | 'gatsby' | 'storybook'
  | null;

export interface NpmFrameworkInfo {
  // Identified framework, or null when nothing matched.
  name: NpmFramework;
  // Human-readable detection source — e.g. 'next.config.ts',
  // 'angular.json', '@sveltejs/kit in dependencies'. Used in the form
  // badge so the user can see WHY we made the call.
  source: string;
  // Best-guess script name to invoke. Matches the framework's
  // convention name when a script with that name exists; otherwise
  // falls back to scripts[0]. Empty string when no scripts at all.
  defaultScript: string;
  // Convention port for this framework's dev server. null when the
  // framework isn't a server (no current cases — every framework in
  // the table binds a port — but kept nullable for future entries
  // like a CLI-only library tooling framework).
  defaultPort: number | null;
}

// What the detector reads from disk + package.json. Pulled into a
// signals struct so the priority logic can be tested without filesystem
// I/O via the exported `detectNpmFrameworkFrom`.
export interface NpmFrameworkSignals {
  // Files present at the project root. The detector cares about specific
  // names — angular.json, next.config.ts, etc. The .storybook directory
  // is represented as '.storybook/' (trailing slash) so the detector
  // can match without ambiguity.
  files: string[];
  // Union of `dependencies` + `devDependencies` from package.json.
  dependencies: string[];
  // Script names declared in package.json's `scripts` block.
  scripts: string[];
  // Full scripts map so we can match keywords inside script bodies
  // (e.g. `react-scripts` invoked via `start: react-scripts start`).
  pkgScripts: Record<string, string>;
}

// Async entry point. Reads disk + package.json, hands off to the pure
// detect-from-signals function.
export async function detectNpmFramework(
  folder: vscode.Uri,
  scripts: string[],
  pkgScripts: Record<string, string>,
  dependencies: string[],
): Promise<NpmFrameworkInfo> {
  const files = await listProbedFiles(folder);
  return detectNpmFrameworkFrom({ files, dependencies, scripts, pkgScripts });
}

// Per-framework specs. Detection priority IS the order of this array —
// the first entry whose signals match wins. Notes inline in the `note`
// field document why a particular ordering matters.
interface FrameworkSpec {
  name: NonNullable<NpmFramework>;
  // File names whose presence at the project root triggers detection.
  files?: string[];
  // Dep names (from `dependencies` ∪ `devDependencies`) whose presence
  // triggers detection.
  deps?: string[];
  // Substring tokens to look for in any script body. Used for CRA
  // (`react-scripts start`) and similar where the dep / file signals
  // are the same as a transitively-included framework.
  scriptTokens?: string[];
  // Convention script names. The detector picks the first one that
  // exists in the project's scripts; falls back to scripts[0].
  preferredScripts: string[];
  defaultPort: number | null;
}

const FRAMEWORK_SPECS: FrameworkSpec[] = [
  // Order matters. Meta-frameworks come BEFORE generic Vite — Next.js
  // / Nuxt / SvelteKit / Astro / Remix all transitively use Vite or
  // Vite-like dev servers, and would mis-claim if Vite came first.
  {
    name: 'nextjs',
    files: ['next.config.js', 'next.config.mjs', 'next.config.ts'],
    deps: ['next'],
    preferredScripts: ['dev'],
    defaultPort: 3000,
  },
  {
    name: 'nuxt',
    files: ['nuxt.config.js', 'nuxt.config.ts'],
    deps: ['nuxt'],
    preferredScripts: ['dev'],
    defaultPort: 3000,
  },
  {
    name: 'sveltekit',
    deps: ['@sveltejs/kit'],
    preferredScripts: ['dev'],
    defaultPort: 5173,
  },
  {
    name: 'astro',
    files: ['astro.config.js', 'astro.config.mjs', 'astro.config.ts'],
    deps: ['astro'],
    preferredScripts: ['dev'],
    defaultPort: 4321,
  },
  {
    name: 'remix',
    files: ['remix.config.js', 'remix.config.ts'],
    deps: ['@remix-run/dev'],
    preferredScripts: ['dev'],
    defaultPort: 3000,
  },
  {
    name: 'gatsby',
    files: ['gatsby-config.js', 'gatsby-config.ts'],
    deps: ['gatsby'],
    preferredScripts: ['develop'],
    defaultPort: 8000,
  },
  {
    name: 'angular',
    files: ['angular.json'],
    deps: ['@angular/core'],
    preferredScripts: ['start'],
    defaultPort: 4200,
  },
  {
    name: 'storybook',
    files: ['.storybook/'],
    deps: ['@storybook/cli'],
    preferredScripts: ['storybook'],
    defaultPort: 6006,
  },
  {
    name: 'svelte',
    files: ['svelte.config.js', 'svelte.config.ts'],
    deps: ['svelte'],
    preferredScripts: ['dev'],
    defaultPort: 5173,
  },
  {
    name: 'vue',
    files: ['vue.config.js'],
    deps: ['@vue/cli-service'],
    preferredScripts: ['serve'],
    defaultPort: 8080,
  },
  {
    name: 'react',
    deps: ['react-scripts'],
    scriptTokens: ['react-scripts'],
    preferredScripts: ['start'],
    defaultPort: 3000,
  },
  // Generic Vite — last priority among matching specs because every
  // meta-framework above may transitively bring in Vite.
  {
    name: 'vite',
    files: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'],
    deps: ['vite'],
    preferredScripts: ['dev'],
    defaultPort: 5173,
  },
];

// Pure function — exported for unit testing. Walks FRAMEWORK_SPECS in
// priority order and returns the first match. Picks the default script
// from the matching spec's preferredScripts (the first one present in
// `scripts`); falls back to `scripts[0]`.
export function detectNpmFrameworkFrom(signals: NpmFrameworkSignals): NpmFrameworkInfo {
  const fileSet = new Set(signals.files);
  const depSet = new Set(signals.dependencies);
  const scriptSet = new Set(signals.scripts);

  for (const spec of FRAMEWORK_SPECS) {
    const matchedFile = spec.files?.find(f => fileSet.has(f));
    const matchedDep = spec.deps?.find(d => depSet.has(d));
    const matchedToken = spec.scriptTokens?.find(t =>
      Object.values(signals.pkgScripts).some(line => new RegExp(`\\b${t}\\b`).test(line)),
    );
    if (!matchedFile && !matchedDep && !matchedToken) continue;

    const source = matchedFile
      ? matchedFile
      : matchedDep
        ? `${matchedDep} in dependencies`
        : `${matchedToken} in scripts`;
    const defaultScript = pickDefaultScript(spec.preferredScripts, signals.scripts, scriptSet);
    return {
      name: spec.name,
      source,
      defaultScript,
      defaultPort: spec.defaultPort,
    };
  }

  return {
    name: null,
    source: '',
    defaultScript: signals.scripts[0] ?? '',
    defaultPort: null,
  };
}

function pickDefaultScript(
  preferred: string[],
  scripts: string[],
  scriptSet: Set<string>,
): string {
  for (const p of preferred) {
    if (scriptSet.has(p)) return p;
  }
  return scripts[0] ?? '';
}

// Stat-checks the small set of project-root files we care about. We
// don't enumerate the directory because that's O(everything) and we
// only need to know whether 30-ish specific names exist.
async function listProbedFiles(folder: vscode.Uri): Promise<string[]> {
  const candidates = [
    'next.config.js', 'next.config.mjs', 'next.config.ts',
    'nuxt.config.js', 'nuxt.config.ts',
    'astro.config.js', 'astro.config.mjs', 'astro.config.ts',
    'remix.config.js', 'remix.config.ts',
    'gatsby-config.js', 'gatsby-config.ts',
    'angular.json',
    'svelte.config.js', 'svelte.config.ts',
    'vue.config.js',
    'vite.config.js', 'vite.config.ts', 'vite.config.mjs',
    '.storybook',
  ];
  const out: string[] = [];
  for (const name of candidates) {
    const uri = vscode.Uri.joinPath(folder, name);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      // Storybook signal is a directory; everything else is a file.
      if (name === '.storybook') {
        if ((stat.type & vscode.FileType.Directory) !== 0) out.push('.storybook/');
      } else {
        out.push(name);
      }
    } catch {
      /* not present */
    }
  }
  log.debug(`detectNpmFramework: probed ${candidates.length} files, ${out.length} present`);
  return out;
}
