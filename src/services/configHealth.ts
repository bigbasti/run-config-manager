import * as vscode from 'vscode';
import type { RunConfig } from '../shared/types';
import { resolveProjectUri } from '../utils/paths';
import { findGradleRoot, findMavenRoot } from '../adapters/spring-boot/findBuildRoot';

// Result of a non-invasive "is this config stale relative to newer detection"
// check. "stale" here means the on-disk config would have been populated
// differently if it were re-created today — typically: buildRoot missing on a
// submodule, which leads the new runtime to pick the wrong cwd or miss the
// :module: gradle prefix. We never rewrite the config; we only nudge the user.
export type ConfigHealth =
  | { healthy: true }
  | { healthy: false; reason: string };

// Cache keyed by a cheap fingerprint so the tree provider doesn't re-probe the
// filesystem on every render. The fingerprint covers just the fields the
// check consults — identical configs for identical projects share a probe.
interface CacheEntry { fp: string; result: ConfigHealth }
const cache = new Map<string, CacheEntry>();

// Clear the cache — tests use this to isolate probes between cases. In
// production the cache is populated on demand and lives for the session.
export function resetConfigHealthCache(): void {
  cache.clear();
}

export async function checkConfigHealth(
  cfg: RunConfig,
  folder: vscode.WorkspaceFolder,
): Promise<ConfigHealth> {
  const fp = fingerprint(cfg, folder);
  const hit = cache.get(cfg.id);
  if (hit && hit.fp === fp) return hit.result;

  const result = await runCheck(cfg, folder);
  cache.set(cfg.id, { fp, result });
  return result;
}

// Synchronous peek at the last-known health state. Used by the tree provider
// on the first render (before the async probe kicks off) so we don't flicker
// between "no badge" and "warning badge". Returns undefined if unknown.
export function peekConfigHealth(cfg: RunConfig, folder: vscode.WorkspaceFolder): ConfigHealth | undefined {
  const hit = cache.get(cfg.id);
  if (!hit) return undefined;
  if (hit.fp !== fingerprint(cfg, folder)) return undefined;
  return hit.result;
}

function fingerprint(cfg: RunConfig, folder: vscode.WorkspaceFolder): string {
  // Covers every input runCheck reads. Deliberately does NOT include fields
  // outside the health check's scope (e.g. profiles) — those shouldn't
  // trigger re-probing on a filesystem walk.
  const to = cfg.typeOptions as any;
  return JSON.stringify({
    t: cfg.type,
    p: cfg.projectPath,
    f: folder.uri.fsPath,
    br: to?.buildRoot ?? '',
    bpp: to?.buildProjectPath ?? '',
    bt: to?.buildTool ?? '',
    lm: to?.launchMode ?? '',
  });
}

// Types for which buildRoot is consulted at launch. For others the check is a
// no-op.
function needsBuildRoot(cfg: RunConfig): boolean {
  if (cfg.type === 'spring-boot') {
    return cfg.typeOptions.launchMode === 'maven' || cfg.typeOptions.launchMode === 'gradle';
  }
  if (cfg.type === 'java') {
    const m = cfg.typeOptions.launchMode;
    return m === 'maven' || m === 'gradle' || m === 'maven-custom' || m === 'gradle-custom';
  }
  if (cfg.type === 'quarkus') return true;
  if (cfg.type === 'maven-goal') return true;
  if (cfg.type === 'gradle-task') return true;
  // Tomcat's runtime re-runs findGradleRoot at launch when buildRoot is empty
  // (see tomcatRuntime.ts / runBuildIfNeeded), so an empty buildRoot there is
  // benign. Skip the warning.
  return false;
}

async function runCheck(cfg: RunConfig, folder: vscode.WorkspaceFolder): Promise<ConfigHealth> {
  if (!needsBuildRoot(cfg)) return { healthy: true };

  const to = cfg.typeOptions as { buildRoot?: string };
  if (to.buildRoot && to.buildRoot.trim()) {
    // User (or newer detection) already populated it — nothing to flag.
    return { healthy: true };
  }

  // buildRoot is empty. That's only a problem when the projectPath points at
  // a submodule whose build-tool root lives in an ancestor. Single-module
  // projects at the workspace root or at projectPath itself are fine with an
  // empty buildRoot.
  const projectUri = resolveProjectUri(folder, cfg.projectPath);
  const detectedRoot = await detectBuildRoot(cfg, projectUri);
  if (!detectedRoot) return { healthy: true }; // no build tool detected — skip

  if (detectedRoot.fsPath === projectUri.fsPath) {
    // The project folder IS the build root — empty buildRoot is correct.
    return { healthy: true };
  }

  // projectPath is nested below the build root. The config was saved before
  // detection learned to walk up, so the runtime will `cd projectPath` and
  // miss the wrapper / reactor root.
  return {
    healthy: false,
    reason:
      `This config predates the submodule-aware detection — it points at a sub-project but has no "build root" set. ` +
      `Runs may use the wrong working directory or skip the module prefix. ` +
      `Delete + re-create this config to pick up the fix (no auto-rewrite).`,
  };
}

async function detectBuildRoot(
  cfg: RunConfig,
  projectUri: vscode.Uri,
): Promise<vscode.Uri | null> {
  // Use the build tool the config says it uses when available; fall back to
  // probing both when it's ambiguous (maven-goal / gradle-task are already
  // committed by type).
  const to = cfg.typeOptions as { buildTool?: 'maven' | 'gradle' | 'none' };
  if (cfg.type === 'maven-goal') return findMavenRoot(projectUri);
  if (cfg.type === 'gradle-task') return findGradleRoot(projectUri);
  if (to.buildTool === 'gradle') return findGradleRoot(projectUri);
  if (to.buildTool === 'maven')  return findMavenRoot(projectUri);
  // Ambiguous — try gradle first (cheaper signal: single wrapper file),
  // then maven.
  const g = await findGradleRoot(projectUri);
  if (g.fsPath !== projectUri.fsPath) return g;
  const m = await findMavenRoot(projectUri);
  if (m.fsPath !== projectUri.fsPath) return m;
  return null;
}
