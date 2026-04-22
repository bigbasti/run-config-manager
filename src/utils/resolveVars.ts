// Variable expansion for run-config text fields.
//
// Supported syntaxes:
//   ${VAR}              — environment variable lookup
//   ${env:VAR}          — explicit env lookup (VS Code task/launch syntax)
//   ${workspaceFolder}  — absolute path of the workspace folder
//   ${userHome}         — $HOME / %USERPROFILE%
//   ${cwd}              — resolved project path (same dir the process runs from)
//   ${projectPath}      — alias for ${cwd}
//
// Unresolved variables expand to an empty string. Callers get the list of
// unresolved names back so UIs can warn about them.

export interface ResolverContext {
  env: NodeJS.ProcessEnv;      // base env (usually process.env)
  workspaceFolder: string;
  userHome: string;
  cwd: string;
}

export interface ResolveResult {
  value: string;
  unresolved: string[];        // variable names that had no value
}

const BUILTINS = new Set(['workspaceFolder', 'userHome', 'cwd', 'projectPath']);

// Matches ${...}. The body allows anything that isn't `}`; we post-parse for
// the `env:` prefix so both ${VAR} and ${env:VAR} work.
const VAR_RE = /\$\{([^}]+)\}/g;

export function resolveVars(input: string, ctx: ResolverContext): ResolveResult {
  const unresolved: string[] = [];
  const value = input.replace(VAR_RE, (_match, raw: string) => {
    const name = raw.trim();
    const sub = lookup(name, ctx);
    if (sub === undefined) {
      unresolved.push(name);
      return '';
    }
    return sub;
  });
  return { value, unresolved };
}

function lookup(name: string, ctx: ResolverContext): string | undefined {
  if (name === 'workspaceFolder') return ctx.workspaceFolder;
  if (name === 'userHome') return ctx.userHome;
  if (name === 'cwd' || name === 'projectPath') return ctx.cwd;
  if (name.startsWith('env:')) return ctx.env[name.slice(4)];
  // Bare names are env lookups (but reject anything that might shadow a builtin).
  if (BUILTINS.has(name)) return undefined;  // unreachable, handled above
  return ctx.env[name];
}

// Resolves every string leaf in an object/array, deep. Returns a new value
// with expansions applied plus a merged unresolved list. Keys are never
// resolved (only values). Non-string leaves (numbers, booleans, undefined)
// pass through.
export function resolveDeep<T>(
  value: T,
  ctx: ResolverContext,
  unresolvedOut: string[] = [],
): T {
  if (typeof value === 'string') {
    const r = resolveVars(value, ctx);
    for (const u of r.unresolved) unresolvedOut.push(u);
    return r.value as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map(v => resolveDeep(v, ctx, unresolvedOut)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = resolveDeep(v, ctx, unresolvedOut);
    }
    return out as unknown as T;
  }
  return value;
}

// Convenience: resolve deeply and also dedupe the unresolved list.
export function resolveConfig<T>(value: T, ctx: ResolverContext): { value: T; unresolved: string[] } {
  const unresolvedOut: string[] = [];
  const resolved = resolveDeep(value, ctx, unresolvedOut);
  return { value: resolved, unresolved: Array.from(new Set(unresolvedOut)).sort() };
}

// Builds a resolver context suitable for a RunConfig launch. Requires the
// workspace folder's absolute path and the cwd the process will run in.
export function makeRunContext(opts: {
  workspaceFolder: string;
  cwd: string;
  env?: NodeJS.ProcessEnv;
}): ResolverContext {
  return {
    env: opts.env ?? process.env,
    workspaceFolder: opts.workspaceFolder,
    userHome: process.env.HOME ?? process.env.USERPROFILE ?? '',
    cwd: opts.cwd,
  };
}
