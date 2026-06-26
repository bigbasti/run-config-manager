// Env vars that make the bundled Node agent load in-process and dial back to
// the extension. Shared by the run path (NpmAdapter.prepareLaunch) and the
// debug path (DebugService). NODE_OPTIONS supports quoted paths, so a path
// with spaces is safe.
export function buildNodeMonitorEnv(
  agentPath: string,
  port: number,
  configId: string,
): Record<string, string> {
  const requireFlag = `--require "${agentPath}"`;
  const existing = process.env.NODE_OPTIONS;
  return {
    NODE_OPTIONS: existing ? `${existing} ${requireFlag}` : requireFlag,
    RCM_MONITOR_PORT: String(port),
    RCM_MONITOR_ID: configId,
  };
}
