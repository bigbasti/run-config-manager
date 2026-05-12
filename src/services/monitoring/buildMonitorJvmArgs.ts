// Builds the JMX flag list that turns on a localhost-only, no-auth JMX
// server on the given port. Mirrors the well-known incantation used by
// VisualVM / JConsole / IntelliJ for IDE-side local profiling.
//
// Notes on each flag:
//   - jmxremote=true: opt in
//   - jmxremote.port: the listener port for the registry
//   - jmxremote.rmi.port: pinned to the SAME port so RMI doesn't pick
//     an ephemeral one (which a firewall might block). Required to make
//     the agent's JMXServiceURL reach the JVM.
//   - local.only=true: bind to localhost interfaces only — never accepts
//     remote connections.
//   - authenticate=false / ssl=false: same posture every IDE-side
//     profiler uses; safe because of local.only.
//   - java.rmi.server.hostname=127.0.0.1: tell RMI to advertise a
//     loopback hostname even on hosts where Java would otherwise pick
//     the LAN-routable address (Linux + WSL is a common case).
//
// Same args are appropriate for every JVM type — Spring Boot, Quarkus,
// Java, Tomcat. Each adapter just decides WHICH env channel to inject
// them through (JAVA_TOOL_OPTIONS, vmArgs, CATALINA_OPTS).
export function buildMonitorJvmArgs(port: number): string[] {
  return [
    '-Dcom.sun.management.jmxremote=true',
    `-Dcom.sun.management.jmxremote.port=${port}`,
    `-Dcom.sun.management.jmxremote.rmi.port=${port}`,
    '-Dcom.sun.management.jmxremote.local.only=true',
    '-Dcom.sun.management.jmxremote.authenticate=false',
    '-Dcom.sun.management.jmxremote.ssl=false',
    '-Djava.rmi.server.hostname=127.0.0.1',
  ];
}
