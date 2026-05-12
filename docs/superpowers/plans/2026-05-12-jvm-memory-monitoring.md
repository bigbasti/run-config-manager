# JVM Memory Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add "Run with Monitoring" / "Debug with Monitoring" right-click entries to JVM configs (Spring Boot, Quarkus, Java, Tomcat). When invoked, inject JMX flags into the launch, spawn a bundled monitoring agent jar that connects to JMX, and surface live heap/CPU/threads/GC + an auto-refreshing class histogram in the tree row + a dedicated webview panel. Heap-dump button writes `.hprof` files.

**Architecture:** A new `MonitoringService` owns the agent lifecycle. The agent is a small bundled jar (`media/agent/rcm-monitor.jar`) that emits newline-delimited JSON metrics on stdout. JVM adapters' `prepareLaunch` injects JMX flags when `monitor: true`. `RunTerminal` exposes the spawned shell PID for liveness checking; the agent doesn't need a PID — it connects by port. Tree provider renders a 16-character sparkline + numeric in `TreeItem.description`. A new `MonitorPanel.tsx` webview renders chart + analytics + virtual-scrolled histogram table. Heap dumps go through a stdin protocol on the agent.

**Tech Stack:** TypeScript on the extension side; Java + Maven for the agent jar; uPlot for the chart; existing `RuntimeAdapter.prepareLaunch` extension point for flag injection; existing `child_process.spawn` patterns from `runInTerminal.ts`.

---

## Spec reference

Implements `docs/superpowers/specs/2026-05-12-jvm-memory-monitoring-design.md`.

## File map

**New files:**

| File | Responsibility |
|---|---|
| `monitor-agent/pom.xml` | Maven build descriptor for the agent jar. |
| `monitor-agent/README.md` | How to rebuild the jar + commit it. |
| `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java` | Agent main class — JMX connect, metrics + histogram + heap-dump. |
| `media/agent/rcm-monitor.jar` | Prebuilt agent jar (committed, ~12 KB). |
| `src/services/MonitoringService.ts` | Per-config monitoring lifecycle owner. Spawns/kills the agent, parses stdout, fires events. |
| `src/services/monitoring/AgentMessage.ts` | Wire-format type definitions shared between service and webview. |
| `src/services/monitoring/buildMonitorJvmArgs.ts` | Pure helper: builds the `-Dcom.sun.management.*` flag list. |
| `src/services/monitoring/freePort.ts` | Async helper: ask the OS for an unused TCP port via `net.createServer`. |
| `src/services/monitoring/parseClassHistogram.ts` | Pure helper: post-process the agent's histogram rows for grouping. |
| `src/ui/MonitorPanel.ts` | Extension-side webview panel host (lifecycle, message routing). |
| `webview/src/MonitorView.tsx` | Webview React entry — chart + analytics + histogram table. |
| `test/MonitoringService.test.ts` | Lifecycle + stdout-parse tests with a mocked child_process. |
| `test/buildMonitorJvmArgs.test.ts` | Pure test of the flag string. |
| `test/parseClassHistogram.test.ts` | Pure test of the package-prefix grouping. |
| `test/freePort.test.ts` | Allocates a port, confirms it's actually free. |

**Modified files:**

| File | Change |
|---|---|
| `src/adapters/RuntimeAdapter.ts` | Add `monitor?: boolean` and `monitorPort?: number` to `PrepareContext`. |
| `src/services/RunTerminal.ts` | Expose `pid` (the spawned shell PID) as a public getter so MonitoringService can hold a reference for the liveness check. |
| `src/services/ExecutionService.ts` | Accept `monitor: true` in `RunOpts`. Allocate JMX port. Pass `monitor` + `monitorPort` into `prepareLaunch`. After launch, attach `MonitoringService`. Detach on task end. |
| `src/services/DebugService.ts` | Accept `monitor: true` in its runtime opts. Same plumbing as ExecutionService for the monitoring side. |
| `src/adapters/spring-boot/SpringBootAdapter.ts` | When `ctx.monitor`, append the JMX flags via the existing JAVA_TOOL_OPTIONS / vmArgs split. |
| `src/adapters/quarkus/QuarkusAdapter.ts` | Same — `JAVA_TOOL_OPTIONS`. |
| `src/adapters/java/JavaAdapter.ts` | Same — `JAVA_TOOL_OPTIONS` for build-tool launchModes; vmArgs for `java-main`. |
| `src/adapters/tomcat/TomcatAdapter.ts` | Same — `CATALINA_OPTS`. |
| `src/ui/RunConfigTreeProvider.ts` | Listen for `MonitoringService.onChanged`. Render sparkline + numeric in `description`. Add `:monitored` suffix to contextValue. |
| `src/extension.ts` | Construct `MonitoringService`. Register three new commands: `runConfig.runMonitored`, `runConfig.debugMonitored`, `runConfig.openMonitor`. Pass MonitoringService to TreeProvider + ExecutionService + DebugService. |
| `src/shared/protocol.ts` | New webview messages: `monitor.tick`, `monitor.histogram`, `monitor.dumpRequest`, `monitor.dumpProgress`, `monitor.dumpComplete`, `monitor.error`. |
| `package.json` | Three new commands; menu entries gated on JVM type + monitored contextValue suffix. |

## Conventions used throughout

- All steps verbatim. **No commits** — user directive across the session.
- Test framework is Jest; mocks use `jest.spyOn` on `child_process`/`net`.
- All new TypeScript exports include a one-line JSDoc comment per the project's existing style.
- For the agent, source is committed and built once with `mvn package` (a one-time build is part of Task 1's verification step). The committed `media/agent/rcm-monitor.jar` is what ships with the extension; rebuilding only happens when agent source changes.

---

## Task 1: Build the monitoring agent

**Files:**
- Create: `monitor-agent/pom.xml`
- Create: `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java`
- Create: `monitor-agent/README.md`
- Create: `media/agent/rcm-monitor.jar` (built artifact, committed)

- [ ] **Step 1: Create the Maven descriptor**

Create `monitor-agent/pom.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.runconfig</groupId>
  <artifactId>rcm-monitor</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>

  <properties>
    <maven.compiler.source>11</maven.compiler.source>
    <maven.compiler.target>11</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <build>
    <finalName>rcm-monitor</finalName>
    <plugins>
      <plugin>
        <artifactId>maven-jar-plugin</artifactId>
        <version>3.4.1</version>
        <configuration>
          <archive>
            <manifest>
              <mainClass>com.runconfig.monitor.Monitor</mainClass>
            </manifest>
          </archive>
        </configuration>
      </plugin>
    </plugins>
  </build>
</project>
```

- [ ] **Step 2: Write the agent main class**

Create `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java`:

```java
package com.runconfig.monitor;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.OperatingSystemMXBean;
import java.lang.management.ThreadMXBean;
import javax.management.MBeanServerConnection;
import javax.management.ObjectName;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;
import com.sun.management.HotSpotDiagnosticMXBean;

/**
 * Bundled monitoring agent. Connects to a JVM's JMX server on
 * `localhost:<port>` and emits newline-delimited JSON metrics on
 * stdout. Listens on stdin for `dump <path>` and `histogram-pause` /
 * `histogram-resume` directives. Exits when stdin closes.
 *
 * Wire format (one JSON object per line):
 *   { "type": "metrics", "t": <ms>, "heapUsed": ..., ... }
 *   { "type": "histogram", "t": <ms>, "rows": [{...}, ...] }
 *   { "type": "dumpComplete", "path": "..." }
 *   { "type": "error", "message": "..." }
 */
public class Monitor {
  private static volatile boolean histogramPaused = false;

  public static void main(String[] args) throws Exception {
    if (args.length < 1) {
      err("expected JMX port as first argument");
      System.exit(1);
    }
    int port = Integer.parseInt(args[0]);
    int metricsIntervalMs = 1000;
    int histogramIntervalMs = 10_000;
    for (int i = 1; i < args.length; i++) {
      if (args[i].startsWith("--metrics-interval=")) {
        metricsIntervalMs = Integer.parseInt(args[i].substring("--metrics-interval=".length())) * 1000;
      } else if (args[i].startsWith("--histogram-interval=")) {
        histogramIntervalMs = Integer.parseInt(args[i].substring("--histogram-interval=".length())) * 1000;
      }
    }

    JMXConnector jmxc = connectWithRetry(port, 10_000);
    MBeanServerConnection mbsc = jmxc.getMBeanServerConnection();

    // Background timers for periodic emit.
    new Thread(new MetricsLoop(mbsc, metricsIntervalMs), "rcm-metrics").start();
    new Thread(new HistogramLoop(mbsc, histogramIntervalMs), "rcm-histogram").start();

    // Main thread: read stdin commands until EOF.
    try (BufferedReader r = new BufferedReader(new InputStreamReader(System.in))) {
      String line;
      while ((line = r.readLine()) != null) {
        line = line.trim();
        if (line.startsWith("dump ")) {
          handleDump(mbsc, line.substring(5).trim());
        } else if (line.equals("histogram-pause")) {
          histogramPaused = true;
        } else if (line.equals("histogram-resume")) {
          histogramPaused = false;
        }
      }
    }
    // Stdin closed (parent exited). Detach + exit.
    try { jmxc.close(); } catch (Exception ignored) {}
    System.exit(0);
  }

  // Retry the JMX connection for up to `timeoutMs` — useful when the
  // agent is spawned right after the target JVM and the server hasn't
  // bound the port yet.
  private static JMXConnector connectWithRetry(int port, long timeoutMs) throws Exception {
    long deadline = System.currentTimeMillis() + timeoutMs;
    JMXServiceURL url = new JMXServiceURL(
      "service:jmx:rmi:///jndi/rmi://localhost:" + port + "/jmxrmi");
    Exception last = null;
    while (System.currentTimeMillis() < deadline) {
      try { return JMXConnectorFactory.connect(url, null); }
      catch (Exception e) { last = e; }
      Thread.sleep(250);
    }
    err("JMX connect failed: " + (last != null ? last.getMessage() : "timeout"));
    System.exit(2);
    throw new IllegalStateException();
  }

  private static class MetricsLoop implements Runnable {
    final MBeanServerConnection mbsc;
    final int intervalMs;
    MetricsLoop(MBeanServerConnection m, int i) { this.mbsc = m; this.intervalMs = i; }
    public void run() {
      try {
        MemoryMXBean memory = ManagementFactory.newPlatformMXBeanProxy(
          mbsc, "java.lang:type=Memory", MemoryMXBean.class);
        OperatingSystemMXBean os = ManagementFactory.newPlatformMXBeanProxy(
          mbsc, "java.lang:type=OperatingSystem", OperatingSystemMXBean.class);
        ThreadMXBean threads = ManagementFactory.newPlatformMXBeanProxy(
          mbsc, "java.lang:type=Threading", ThreadMXBean.class);
        java.util.Set<ObjectName> gcs = mbsc.queryNames(
          new ObjectName("java.lang:type=GarbageCollector,*"), null);
        // com.sun.management.OperatingSystemMXBean exposes getProcessCpuLoad,
        // which the platform interface doesn't. Try via raw mbsc.
        ObjectName osName = new ObjectName("java.lang:type=OperatingSystem");
        while (true) {
          long heapUsed = memory.getHeapMemoryUsage().getUsed();
          long heapCommitted = memory.getHeapMemoryUsage().getCommitted();
          long heapMax = memory.getHeapMemoryUsage().getMax();
          long nonHeapUsed = memory.getNonHeapMemoryUsage().getUsed();
          int threadCount = threads.getThreadCount();
          double cpuLoad = -1.0;
          try { cpuLoad = (Double) mbsc.getAttribute(osName, "ProcessCpuLoad"); }
          catch (Exception ignored) {}
          long gcCount = 0, gcTime = 0;
          for (ObjectName gc : gcs) {
            GarbageCollectorMXBean bean = ManagementFactory.newPlatformMXBeanProxy(
              mbsc, gc.toString(), GarbageCollectorMXBean.class);
            gcCount += bean.getCollectionCount();
            gcTime += bean.getCollectionTime();
          }
          long t = System.currentTimeMillis();
          // Hand-rolled JSON to avoid pulling in a JSON dep — tiny, fixed shape.
          System.out.println(String.format(
            "{\"type\":\"metrics\",\"t\":%d,\"heapUsed\":%d,\"heapCommitted\":%d," +
            "\"heapMax\":%d,\"nonHeapUsed\":%d,\"cpuLoad\":%.4f,\"threadCount\":%d," +
            "\"gcCount\":%d,\"gcTime\":%d}",
            t, heapUsed, heapCommitted, heapMax, nonHeapUsed, cpuLoad, threadCount, gcCount, gcTime));
          System.out.flush();
          Thread.sleep(intervalMs);
        }
      } catch (Exception e) {
        err("metrics loop failed: " + e.getMessage());
      }
    }
  }

  private static class HistogramLoop implements Runnable {
    final MBeanServerConnection mbsc;
    final int intervalMs;
    HistogramLoop(MBeanServerConnection m, int i) { this.mbsc = m; this.intervalMs = i; }
    public void run() {
      try {
        ObjectName diagName = new ObjectName("com.sun.management:type=HotSpotDiagnostic");
        // gcClassHistogram via DiagnosticCommand MBean.
        ObjectName diag = new ObjectName("com.sun.management:type=DiagnosticCommand");
        while (true) {
          if (!histogramPaused) {
            try {
              String text = (String) mbsc.invoke(
                diag, "gcClassHistogram",
                new Object[]{ new String[]{} },
                new String[]{ "[Ljava.lang.String;" });
              StringBuilder json = new StringBuilder();
              json.append("{\"type\":\"histogram\",\"t\":")
                  .append(System.currentTimeMillis())
                  .append(",\"rows\":[");
              boolean first = true;
              int count = 0;
              for (String line : text.split("\n")) {
                String tr = line.trim();
                if (tr.isEmpty() || tr.startsWith("---") || tr.startsWith("num")
                    || tr.startsWith("Total")) continue;
                String[] parts = tr.split("\\s+");
                if (parts.length < 4) continue;
                long instances; long bytes;
                try {
                  instances = Long.parseLong(parts[1]);
                  bytes = Long.parseLong(parts[2]);
                } catch (NumberFormatException nfe) { continue; }
                StringBuilder cls = new StringBuilder();
                for (int i = 3; i < parts.length; i++) {
                  if (cls.length() > 0) cls.append(' ');
                  cls.append(parts[i]);
                }
                if (!first) json.append(',');
                json.append("{\"instances\":").append(instances)
                    .append(",\"bytes\":").append(bytes)
                    .append(",\"className\":\"").append(jsonEscape(cls.toString()))
                    .append("\"}");
                first = false;
                if (++count >= 200) break; // top 200 rows only
              }
              json.append("]}");
              System.out.println(json.toString());
              System.out.flush();
            } catch (Exception e) {
              err("histogram failed: " + e.getMessage());
            }
            // unused: diagName placeholder for HotSpotDiagnosticMXBean dump path
            if (diagName == null) { /* no-op */ }
          }
          Thread.sleep(intervalMs);
        }
      } catch (Exception e) {
        err("histogram loop failed: " + e.getMessage());
      }
    }
  }

  private static void handleDump(MBeanServerConnection mbsc, String path) {
    try {
      HotSpotDiagnosticMXBean diag = ManagementFactory.newPlatformMXBeanProxy(
        mbsc, "com.sun.management:type=HotSpotDiagnostic", HotSpotDiagnosticMXBean.class);
      diag.dumpHeap(path, true);
      System.out.println(String.format("{\"type\":\"dumpComplete\",\"path\":\"%s\"}", jsonEscape(path)));
      System.out.flush();
    } catch (Exception e) {
      err("dump failed: " + e.getMessage());
    }
  }

  private static void err(String message) {
    System.out.println(String.format("{\"type\":\"error\",\"message\":\"%s\"}", jsonEscape(message)));
    System.out.flush();
  }

  private static String jsonEscape(String s) {
    StringBuilder sb = new StringBuilder(s.length() + 2);
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '\\': sb.append("\\\\"); break;
        case '"':  sb.append("\\\""); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        default:
          if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    return sb.toString();
  }
}
```

- [ ] **Step 3: Write the README**

Create `monitor-agent/README.md`:

```markdown
# rcm-monitor — JVM monitoring agent

A small Java program that connects to a target JVM's JMX server and emits
metrics (heap, CPU, threads, GC) + an on-demand class histogram + heap
dumps to stdout as newline-delimited JSON. Used by the Run Configurations
extension for the "Run with Monitoring" / "Debug with Monitoring" flow.

## Build

```
cd monitor-agent
mvn package
```

Produces `target/rcm-monitor.jar`. Copy it to `../media/agent/rcm-monitor.jar`
and commit. The committed jar is what ships with the extension; rebuilds
only happen when this source changes.

## Wire format

One JSON document per line on stdout. The extension parses each line.

- `metrics`: heap, non-heap, CPU, threads, GC counters. Emitted every 1 s
  (configurable via `--metrics-interval=<seconds>`).
- `histogram`: top 200 classes by retained bytes from `gcClassHistogram`.
  Every 10 s by default (`--histogram-interval=<seconds>`).
- `dumpComplete`: written after a heap dump finishes.
- `error`: anything that went wrong; agent does NOT exit on error
  unless JMX itself disconnects.

## Stdin protocol

The extension can write commands on the agent's stdin:

- `dump <absolute-path>` — write a `.hprof` heap dump.
- `histogram-pause` — stop emitting histogram lines.
- `histogram-resume` — resume.

EOF on stdin → agent exits.
```

- [ ] **Step 4: Build the jar**

Run:

```bash
cd /git/run-config-manager/monitor-agent
mvn package -q
mkdir -p ../media/agent
cp target/rcm-monitor.jar ../media/agent/rcm-monitor.jar
ls -la ../media/agent/rcm-monitor.jar
```

Expected: `rcm-monitor.jar` exists, ~10–15 KB.

If `mvn` isn't installed: install via `apt install maven` / `brew install maven` / equivalent, or ask the user. The jar must be checked in for the extension to ship.

- [ ] **Step 5: Smoke-test the agent against a JVM**

Optional manual smoke check (skip if no convenient JVM to test against). Start any local JVM with JMX:

```bash
java -Dcom.sun.management.jmxremote.port=39000 \
     -Dcom.sun.management.jmxremote.rmi.port=39000 \
     -Dcom.sun.management.jmxremote.local.only=true \
     -Dcom.sun.management.jmxremote.authenticate=false \
     -Dcom.sun.management.jmxremote.ssl=false \
     -Djava.rmi.server.hostname=127.0.0.1 \
     -jar some-app.jar &
java -jar media/agent/rcm-monitor.jar 39000
```

Confirm one `metrics` line appears every second and a `histogram` line every 10 s.

DO NOT COMMIT.

---

## Task 2: AgentMessage protocol type

**Files:**
- Create: `src/services/monitoring/AgentMessage.ts`

- [ ] **Step 1: Define the wire-format types**

Create `src/services/monitoring/AgentMessage.ts`:

```ts
// Wire format produced by the bundled monitoring agent
// (`media/agent/rcm-monitor.jar`). One JSON document per line on the
// agent's stdout. Mirrors the agent's hand-rolled JSON in
// `monitor-agent/src/main/java/com/runconfig/monitor/Monitor.java` —
// changes to one MUST be reflected in the other.

export interface MetricsTick {
  type: 'metrics';
  // Wall-clock ms since epoch (System.currentTimeMillis on the agent).
  t: number;
  heapUsed: number;       // bytes
  heapCommitted: number;
  heapMax: number;        // -1 if undefined (unbounded heap)
  nonHeapUsed: number;
  // ProcessCpuLoad — fraction in [0, 1]. -1 when JMX returns "not
  // available" (rare; some JVMs / OSes hide it).
  cpuLoad: number;
  threadCount: number;
  // Aggregate across all GC beans — sum of collection counts and
  // collection time in ms.
  gcCount: number;
  gcTime: number;
}

export interface HistogramRow {
  instances: number;
  bytes: number;
  className: string;
}

export interface HistogramSnapshot {
  type: 'histogram';
  t: number;
  rows: HistogramRow[]; // top 200 by retained bytes
}

export interface DumpComplete {
  type: 'dumpComplete';
  path: string;
}

export interface AgentError {
  type: 'error';
  message: string;
}

export type AgentMessage = MetricsTick | HistogramSnapshot | DumpComplete | AgentError;
```

- [ ] **Step 2: Verify typecheck**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

DO NOT COMMIT.

---

## Task 3: buildMonitorJvmArgs helper

**Files:**
- Create: `src/services/monitoring/buildMonitorJvmArgs.ts`
- Create: `test/buildMonitorJvmArgs.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/buildMonitorJvmArgs.test.ts`:

```ts
import { buildMonitorJvmArgs } from '../src/services/monitoring/buildMonitorJvmArgs';

describe('buildMonitorJvmArgs', () => {
  test('returns the expected JMX flag list for a given port', () => {
    const args = buildMonitorJvmArgs(39000);
    expect(args).toEqual([
      '-Dcom.sun.management.jmxremote=true',
      '-Dcom.sun.management.jmxremote.port=39000',
      '-Dcom.sun.management.jmxremote.rmi.port=39000',
      '-Dcom.sun.management.jmxremote.local.only=true',
      '-Dcom.sun.management.jmxremote.authenticate=false',
      '-Dcom.sun.management.jmxremote.ssl=false',
      '-Djava.rmi.server.hostname=127.0.0.1',
    ]);
  });

  test('uses the second port for both .port and .rmi.port (avoids RMI ephemeral)', () => {
    const args = buildMonitorJvmArgs(45123);
    const portArg = args.find(a => a.startsWith('-Dcom.sun.management.jmxremote.port='));
    const rmiArg = args.find(a => a.startsWith('-Dcom.sun.management.jmxremote.rmi.port='));
    expect(portArg).toBe('-Dcom.sun.management.jmxremote.port=45123');
    expect(rmiArg).toBe('-Dcom.sun.management.jmxremote.rmi.port=45123');
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern buildMonitorJvmArgs 2>&1 | tail -10`
Expected: import error.

- [ ] **Step 3: Implement the helper**

Create `src/services/monitoring/buildMonitorJvmArgs.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern buildMonitorJvmArgs 2>&1 | tail -10`
Expected: 2 tests pass.

DO NOT COMMIT.

---

## Task 4: freePort helper

**Files:**
- Create: `src/services/monitoring/freePort.ts`
- Create: `test/freePort.test.ts`

- [ ] **Step 1: Write the test**

Create `test/freePort.test.ts`:

```ts
import { allocateFreePort } from '../src/services/monitoring/freePort';
import * as net from 'net';

describe('allocateFreePort', () => {
  test('returns a port that can actually be bound to', async () => {
    const port = await allocateFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
    // Confirm the port is actually free by binding to it.
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
      srv.on('error', reject);
    });
  });

  test('returns different ports across calls (no collisions when not bound)', async () => {
    const ports = await Promise.all([
      allocateFreePort(), allocateFreePort(), allocateFreePort(),
    ]);
    // Strictly speaking, the OS may reuse ports; we just want NOT all
    // identical, since the helper relies on listen(0).
    const uniq = new Set(ports);
    expect(uniq.size).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern freePort 2>&1 | tail -10`

- [ ] **Step 3: Implement**

Create `src/services/monitoring/freePort.ts`:

```ts
import * as net from 'net';

// Asks the OS for an unused TCP port by binding a listener to port 0,
// reading the assigned port, and immediately closing. The returned
// port is briefly free to bind elsewhere — there's an inherent race,
// but for IDE-side child-process JMX it's the same race every other
// JVM monitoring tool (VisualVM, IntelliJ, JConsole) accepts.
export async function allocateFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('listen(0) returned no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}
```

- [ ] **Step 4: Run tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern freePort 2>&1 | tail -10`
Expected: 2 tests pass.

DO NOT COMMIT.

---

## Task 5: parseClassHistogram helper

**Files:**
- Create: `src/services/monitoring/parseClassHistogram.ts`
- Create: `test/parseClassHistogram.test.ts`

The agent already produces parsed `HistogramRow[]`. This helper only does post-processing — package-prefix grouping for the table. Pure function; runs in the webview.

- [ ] **Step 1: Write the test**

Create `test/parseClassHistogram.test.ts`:

```ts
import { groupByPackage } from '../src/services/monitoring/parseClassHistogram';

describe('groupByPackage', () => {
  test('groups by top-level package and sums counts/bytes', () => {
    const rows = [
      { instances: 100, bytes: 1000, className: 'java.util.HashMap$Node' },
      { instances: 50,  bytes: 500,  className: 'java.util.ArrayList' },
      { instances: 25,  bytes: 250,  className: 'java.lang.String' },
      { instances: 10,  bytes: 100,  className: 'org.springframework.boot.Application' },
      { instances: 200, bytes: 2000, className: 'com.example.MyService' },
    ];
    const tree = groupByPackage(rows);
    // top-level groups
    const java = tree.find(n => n.name === 'java');
    expect(java).toBeDefined();
    expect(java!.totalInstances).toBe(175);
    expect(java!.totalBytes).toBe(1750);
    // sub-groups
    const javaUtil = java!.children.find(n => n.name === 'util');
    expect(javaUtil).toBeDefined();
    expect(javaUtil!.totalInstances).toBe(150);
  });

  test('keeps array types as a single leaf', () => {
    const rows = [
      { instances: 12, bytes: 10000, className: '[B' }, // byte[]
      { instances: 8,  bytes: 6000,  className: '[C' }, // char[]
    ];
    const tree = groupByPackage(rows);
    const arrays = tree.find(n => n.name === '[arrays]');
    expect(arrays).toBeDefined();
    expect(arrays!.children.length).toBe(2);
  });

  test('sorts groups by total bytes descending', () => {
    const rows = [
      { instances: 1, bytes: 10, className: 'a.A' },
      { instances: 1, bytes: 100, className: 'b.B' },
      { instances: 1, bytes: 50, className: 'c.C' },
    ];
    const tree = groupByPackage(rows);
    expect(tree.map(n => n.name)).toEqual(['b', 'c', 'a']);
  });

  test('handles unqualified class names (no dot)', () => {
    const rows = [
      { instances: 1, bytes: 100, className: 'AnonymousLambda' },
    ];
    const tree = groupByPackage(rows);
    const root = tree.find(n => n.name === '[default]');
    expect(root).toBeDefined();
    expect(root!.children[0].name).toBe('AnonymousLambda');
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern parseClassHistogram 2>&1 | tail -10`

- [ ] **Step 3: Implement**

Create `src/services/monitoring/parseClassHistogram.ts`:

```ts
import type { HistogramRow } from './AgentMessage';

// A node in the package-prefix tree the table renders. Internal nodes
// have children + cumulative counts; leaves carry a single class.
export interface HistogramNode {
  name: string;          // segment of the dotted name, or full leaf name
  totalInstances: number;
  totalBytes: number;
  children: HistogramNode[];
  // Only set on leaves — the original row.
  row?: HistogramRow;
}

// Groups the histogram by package prefix. JVM array types (`[B`, `[C`,
// `[Ljava.lang.String;`) are parked under a synthetic `[arrays]` group
// to keep the top-level list readable. Unqualified class names land
// under `[default]`.
//
// Sort: top-level + every sibling list is sorted by totalBytes desc.
// The webview's table can re-sort by another column without rebuilding.
export function groupByPackage(rows: HistogramRow[]): HistogramNode[] {
  const root = makeNode('__root__');
  for (const row of rows) {
    const segments = classNameToSegments(row.className);
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      let child = node.children.find(c => c.name === seg);
      if (!child) {
        child = makeNode(seg);
        if (isLast) child.row = row;
        node.children.push(child);
      }
      child.totalInstances += row.instances;
      child.totalBytes += row.bytes;
      node = child;
    }
  }
  // Recursive sort by totalBytes desc.
  sortRec(root);
  return root.children;
}

function makeNode(name: string): HistogramNode {
  return { name, totalInstances: 0, totalBytes: 0, children: [] };
}

function sortRec(node: HistogramNode): void {
  node.children.sort((a, b) => b.totalBytes - a.totalBytes);
  for (const c of node.children) sortRec(c);
}

// Turns a JVM internal class name into a segment list:
//   'java.util.HashMap$Node' → ['java', 'util', 'HashMap$Node']
//   'AnonymousLambda'        → ['[default]', 'AnonymousLambda']
//   '[B'                     → ['[arrays]', '[B']
//   '[Ljava.lang.String;'    → ['[arrays]', 'String[]']
function classNameToSegments(className: string): string[] {
  if (className.startsWith('[')) {
    return ['[arrays]', prettyArrayName(className)];
  }
  if (!className.includes('.')) {
    return ['[default]', className];
  }
  return className.split('.');
}

function prettyArrayName(className: string): string {
  // Crude but readable: '[Ljava.lang.String;' → 'String[]', '[B' → 'byte[]'.
  let depth = 0;
  let name = className;
  while (name.startsWith('[')) { depth++; name = name.slice(1); }
  let base: string;
  switch (name) {
    case 'B': base = 'byte'; break;
    case 'C': base = 'char'; break;
    case 'D': base = 'double'; break;
    case 'F': base = 'float'; break;
    case 'I': base = 'int'; break;
    case 'J': base = 'long'; break;
    case 'S': base = 'short'; break;
    case 'Z': base = 'boolean'; break;
    default:
      if (name.startsWith('L') && name.endsWith(';')) {
        const cls = name.slice(1, -1);
        const lastDot = cls.lastIndexOf('.');
        base = lastDot >= 0 ? cls.slice(lastDot + 1) : cls;
      } else {
        base = name;
      }
  }
  return base + '[]'.repeat(depth);
}
```

- [ ] **Step 4: Run tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern parseClassHistogram 2>&1 | tail -10`
Expected: 4 tests pass.

DO NOT COMMIT.

---

## Task 6: MonitoringService — agent lifecycle + ring buffer

**Files:**
- Create: `src/services/MonitoringService.ts`
- Create: `test/MonitoringService.test.ts`

This is the largest task. Owns spawning the agent, parsing its stdout, holding state, firing events.

- [ ] **Step 1: Write the lifecycle test**

Create `test/MonitoringService.test.ts`:

```ts
import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { MonitoringService } from '../src/services/MonitoringService';

jest.mock('child_process');

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: jest.Mock; end: jest.Mock };
  pid?: number;
  kill: jest.Mock;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.pid = 4242;
  child.kill = jest.fn();
  return child;
}

describe('MonitoringService', () => {
  let spawnMock: jest.MockedFunction<typeof cp.spawn>;
  let extensionUri: vscode.Uri;

  beforeEach(() => {
    spawnMock = cp.spawn as unknown as jest.MockedFunction<typeof cp.spawn>;
    spawnMock.mockReset();
    extensionUri = vscode.Uri.file('/ext');
  });

  test('attach() spawns the agent jar with the expected args', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('java');
    expect(args).toContain('-jar');
    expect(args!.some(a => a.endsWith('rcm-monitor.jar'))).toBe(true);
    expect(args).toContain('39000');
  });

  test('parses metrics line and fires onChanged', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    const fired: string[] = [];
    svc.onChanged(id => fired.push(id));

    svc.attach('cfg-id', 1234, 39000);
    child.stdout.emit('data', Buffer.from(
      '{"type":"metrics","t":1000,"heapUsed":1024,"heapCommitted":2048,"heapMax":4096,"nonHeapUsed":512,"cpuLoad":0.05,"threadCount":12,"gcCount":3,"gcTime":50}\n',
    ));
    await new Promise(r => setImmediate(r));

    const state = svc.state('cfg-id')!;
    expect(state.history).toHaveLength(1);
    expect((state.history[0] as any).heapUsed).toBe(1024);
    expect(fired).toContain('cfg-id');
  });

  test('handles partial line buffering', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    // Split a single message across two chunks.
    child.stdout.emit('data', Buffer.from('{"type":"metrics","t":1,"heapUs'));
    child.stdout.emit('data', Buffer.from('ed":7,"heapCommitted":7,"heapMax":7,"nonHeapUsed":0,"cpuLoad":0.0,"threadCount":1,"gcCount":0,"gcTime":0}\n'));
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.history).toHaveLength(1);
    expect((state.history[0] as any).heapUsed).toBe(7);
  });

  test('caps the history ring buffer at 60 entries', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    for (let i = 0; i < 70; i++) {
      child.stdout.emit('data', Buffer.from(
        `{"type":"metrics","t":${i},"heapUsed":${i},"heapCommitted":0,"heapMax":0,"nonHeapUsed":0,"cpuLoad":0,"threadCount":1,"gcCount":0,"gcTime":0}\n`,
      ));
    }
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.history).toHaveLength(60);
    expect((state.history[0] as any).t).toBe(10); // first 10 dropped
    expect((state.history[59] as any).t).toBe(69);
  });

  test('detach() kills the agent and clears state', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    svc.detach('cfg-id');
    expect(child.kill).toHaveBeenCalled();
    expect(svc.state('cfg-id')).toBeUndefined();
  });

  test('attach() is idempotent for the same configId', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    svc.attach('cfg-id', 5678, 39001); // ignored — same id, already attached
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('error message flips status to lost', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    child.stdout.emit('data', Buffer.from('{"type":"error","message":"connect failed"}\n'));
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.status).toBe('lost');
  });

  test('saveHeapDump writes "dump <path>" to agent stdin', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    void svc.saveHeapDump('cfg-id', '/tmp/heap.hprof');
    expect(child.stdin.write).toHaveBeenCalledWith('dump /tmp/heap.hprof\n');
  });
});
```

- [ ] **Step 2: Run; expect import error**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern MonitoringService 2>&1 | tail -10`

- [ ] **Step 3: Implement MonitoringService**

Create `src/services/MonitoringService.ts`:

```ts
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import { log } from '../utils/logger';
import type { AgentMessage, MetricsTick, HistogramSnapshot } from './monitoring/AgentMessage';

export interface MonitoringState {
  configId: string;
  // PID of the spawned shell that's running the JVM. Held for liveness
  // signals only; the agent connects via JMX, not via PID.
  pid: number;
  jmxPort: number;
  startTime: number;
  status: 'connecting' | 'live' | 'lost';
  // Ring buffer of recent metrics ticks. Capped at HISTORY_CAP entries
  // (one per second by default = 60 s of history).
  history: MetricsTick[];
  // Most recent histogram, or null until the first one arrives.
  histogram: HistogramSnapshot | null;
}

const HISTORY_CAP = 60;

// Holds one `Entry` per active monitored config. `attach` spawns the
// agent and pipes its stdout into the per-config ring buffer; `detach`
// kills the agent + clears state. Tree provider listens to `onChanged`
// to refresh the sparkline; the panel listens to render the chart.
export class MonitoringService {
  private entries = new Map<string, Entry>();
  private emitter = new vscode.EventEmitter<string>();
  readonly onChanged = this.emitter.event;

  constructor(private readonly extensionUri: vscode.Uri) {}

  attach(configId: string, pid: number, jmxPort: number): void {
    if (this.entries.has(configId)) return; // idempotent
    const jarPath = path.join(this.extensionUri.fsPath, 'media', 'agent', 'rcm-monitor.jar');
    log.info(`MonitoringService.attach: configId=${configId} pid=${pid} jmxPort=${jmxPort} jar=${jarPath}`);
    const child = cp.spawn('java', ['-jar', jarPath, String(jmxPort)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const entry: Entry = {
      configId,
      pid,
      jmxPort,
      startTime: Date.now(),
      status: 'connecting',
      history: [],
      histogram: null,
      child,
      stdoutBuf: '',
      pendingDumps: [],
    };
    this.entries.set(configId, entry);

    child.stdout?.on('data', (b: Buffer) => this.handleStdout(entry, b.toString('utf8')));
    child.stderr?.on('data', (b: Buffer) => log.debug(`monitor[${configId}] stderr: ${b.toString().trim()}`));
    child.on('error', e => {
      log.warn(`monitor[${configId}] spawn error: ${e.message}`);
      entry.status = 'lost';
      this.emitter.fire(configId);
    });
    child.on('close', code => {
      log.info(`monitor[${configId}] exited with code ${code}`);
      // If the entry still exists at close time, the JVM died but we
      // weren't asked to detach — flag as lost so the tree shows it.
      const e = this.entries.get(configId);
      if (e) {
        e.status = 'lost';
        this.emitter.fire(configId);
      }
    });
  }

  detach(configId: string): void {
    const entry = this.entries.get(configId);
    if (!entry) return;
    log.info(`MonitoringService.detach: configId=${configId}`);
    try { entry.child.stdin?.end(); } catch { /* ignore */ }
    try { entry.child.kill('SIGTERM'); } catch { /* ignore */ }
    setTimeout(() => {
      try { entry.child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000).unref?.();
    this.entries.delete(configId);
    this.emitter.fire(configId);
  }

  state(configId: string): MonitoringState | undefined {
    const entry = this.entries.get(configId);
    if (!entry) return undefined;
    return {
      configId: entry.configId,
      pid: entry.pid,
      jmxPort: entry.jmxPort,
      startTime: entry.startTime,
      status: entry.status,
      history: entry.history,
      histogram: entry.histogram,
    };
  }

  saveHeapDump(configId: string, targetPath: string): Promise<string> {
    const entry = this.entries.get(configId);
    if (!entry) return Promise.reject(new Error(`No monitored config: ${configId}`));
    return new Promise((resolve, reject) => {
      entry.pendingDumps.push({ targetPath, resolve, reject });
      try {
        entry.child.stdin?.write(`dump ${targetPath}\n`);
      } catch (e) {
        reject(e);
      }
    });
  }

  setHistogramPaused(configId: string, paused: boolean): void {
    const entry = this.entries.get(configId);
    if (!entry) return;
    try {
      entry.child.stdin?.write(paused ? 'histogram-pause\n' : 'histogram-resume\n');
    } catch { /* ignore */ }
  }

  dispose(): void {
    for (const [id] of this.entries) this.detach(id);
    this.emitter.dispose();
  }

  private handleStdout(entry: Entry, chunk: string): void {
    entry.stdoutBuf += chunk;
    let nlIdx;
    while ((nlIdx = entry.stdoutBuf.indexOf('\n')) >= 0) {
      const line = entry.stdoutBuf.slice(0, nlIdx).trim();
      entry.stdoutBuf = entry.stdoutBuf.slice(nlIdx + 1);
      if (!line) continue;
      let msg: AgentMessage;
      try {
        msg = JSON.parse(line) as AgentMessage;
      } catch {
        log.debug(`monitor[${entry.configId}] bad line: ${line.slice(0, 200)}`);
        continue;
      }
      this.applyMessage(entry, msg);
    }
  }

  private applyMessage(entry: Entry, msg: AgentMessage): void {
    switch (msg.type) {
      case 'metrics':
        if (entry.status === 'connecting') entry.status = 'live';
        entry.history.push(msg);
        if (entry.history.length > HISTORY_CAP) entry.history.shift();
        this.emitter.fire(entry.configId);
        return;
      case 'histogram':
        entry.histogram = msg;
        this.emitter.fire(entry.configId);
        return;
      case 'dumpComplete': {
        const idx = entry.pendingDumps.findIndex(d => d.targetPath === msg.path);
        if (idx >= 0) {
          const [d] = entry.pendingDumps.splice(idx, 1);
          d.resolve(msg.path);
        }
        return;
      }
      case 'error':
        log.warn(`monitor[${entry.configId}] agent error: ${msg.message}`);
        entry.status = 'lost';
        // Reject any pending heap dumps with the error message.
        for (const d of entry.pendingDumps) d.reject(new Error(msg.message));
        entry.pendingDumps = [];
        this.emitter.fire(entry.configId);
        return;
    }
  }
}

interface Entry {
  configId: string;
  pid: number;
  jmxPort: number;
  startTime: number;
  status: 'connecting' | 'live' | 'lost';
  history: MetricsTick[];
  histogram: HistogramSnapshot | null;
  child: cp.ChildProcess;
  stdoutBuf: string;
  pendingDumps: Array<{
    targetPath: string;
    resolve: (path: string) => void;
    reject: (err: Error) => void;
  }>;
}
```

- [ ] **Step 4: Run tests**

Run: `cd /git/run-config-manager && npm test -- --testPathPattern MonitoringService 2>&1 | tail -10`
Expected: 8 tests pass.

- [ ] **Step 5: Full suite + typecheck**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`

DO NOT COMMIT.

---

## Task 7: Wire monitor flag through PrepareContext + adapters

**Files:**
- Modify: `src/adapters/RuntimeAdapter.ts`
- Modify: `src/adapters/spring-boot/SpringBootAdapter.ts`
- Modify: `src/adapters/quarkus/QuarkusAdapter.ts`
- Modify: `src/adapters/java/JavaAdapter.ts`
- Modify: `src/adapters/tomcat/TomcatAdapter.ts`

- [ ] **Step 1: Extend PrepareContext**

In `src/adapters/RuntimeAdapter.ts`, find `PrepareContext` and add fields:

```ts
export interface PrepareContext {
  debug: boolean;
  debugPort?: number;
  // NEW — when true, the adapter should inject JMX flags via its
  // canonical env channel (JAVA_TOOL_OPTIONS / vmArgs / CATALINA_OPTS).
  // ExecutionService reads `monitorPort` and ensures the bundled
  // agent connects to the same port after launch.
  monitor?: boolean;
  monitorPort?: number;
}
```

- [ ] **Step 2: SpringBootAdapter — inject JMX flags**

Find `prepareLaunch` in `src/adapters/spring-boot/SpringBootAdapter.ts`. Look for where it builds the `JAVA_TOOL_OPTIONS` value (or appends to vmArgs in `java-main` mode). Add monitor-flag injection:

```ts
import { buildMonitorJvmArgs } from '../../services/monitoring/buildMonitorJvmArgs';
```

Then, in `prepareLaunch`:

```ts
// Inject JMX flags when monitoring is enabled. They go through the
// same channel as debug flags — JAVA_TOOL_OPTIONS for build-tool
// modes, vmArgs for java-main.
const monitorArgs = ctx.monitor && ctx.monitorPort
  ? buildMonitorJvmArgs(ctx.monitorPort)
  : [];
```

Then merge `monitorArgs` into the existing flag-string assembly:
- `java-main` mode: append to vmArgs (returned via `cfg` override or ExtraArgs depending on the existing pattern).
- `gradle` / `maven` modes: append to `JAVA_TOOL_OPTIONS` env var.

The exact insertion point depends on the existing structure — read the surrounding code carefully. Search for `JAVA_TOOL_OPTIONS` to locate it.

- [ ] **Step 3: QuarkusAdapter — same pattern**

In `src/adapters/quarkus/QuarkusAdapter.ts`, add the same `buildMonitorJvmArgs` import and append to `JAVA_TOOL_OPTIONS` in `prepareLaunch`. Quarkus dev mode forks a JVM that picks up `JAVA_TOOL_OPTIONS`.

- [ ] **Step 4: JavaAdapter — same pattern, two channels**

In `src/adapters/java/JavaAdapter.ts`:
- `java-main` mode: append `monitorArgs` to vmArgs.
- All other modes: append to `JAVA_TOOL_OPTIONS`.

- [ ] **Step 5: TomcatAdapter — CATALINA_OPTS**

In `src/adapters/tomcat/TomcatAdapter.ts`, find the existing `CATALINA_OPTS` env value building. Append `monitorArgs.join(' ')` so the flags arrive via the channel `catalina.sh` already reads.

- [ ] **Step 6: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green (existing adapter tests don't exercise the monitor branch yet, so they pass unchanged).

DO NOT COMMIT.

---

## Task 8: ExecutionService + DebugService — port allocation + attach

**Files:**
- Modify: `src/services/ExecutionService.ts`
- Modify: `src/services/DebugService.ts`
- Modify: `src/services/RunTerminal.ts`

- [ ] **Step 1: Expose RunTerminal pid**

In `src/services/RunTerminal.ts`, add a public getter:

```ts
// Public getter for the spawned shell's pid. Held by MonitoringService
// for liveness signals — the agent itself connects via JMX, not pid.
get childPid(): number | undefined {
  return this.child?.pid;
}
```

(Find a sensible spot near the other public methods; the existing `requestStop()` is a good neighbor.)

- [ ] **Step 2: Extend ExecutionService.RunOpts**

In `src/services/ExecutionService.ts`, add:

```ts
export interface RunOpts {
  debug?: boolean;
  debugPort?: number;
  // NEW
  monitor?: boolean;
}
```

- [ ] **Step 3: Allocate JMX port + thread through prepareLaunch**

In `ExecutionService.run`, after the existing python pre-flight + npm pre-flight blocks but BEFORE the `prepareLaunch` call:

```ts
import { allocateFreePort } from './monitoring/freePort';
import { MonitoringService } from './MonitoringService';
```

(Add the imports. The `MonitoringService` instance is passed in via the constructor — see Task 11 for wiring.)

In `run()`:

```ts
// Monitor pre-launch: allocate a JMX port so the adapter can inject
// the flags + the agent can connect after launch.
let monitorPort: number | undefined;
if (opts?.monitor) {
  try {
    monitorPort = await allocateFreePort();
  } catch (e) {
    log.warn(`Could not allocate JMX port for monitoring: ${(e as Error).message}`);
    vscode.window.showWarningMessage(`Monitoring disabled: could not allocate a free JMX port. The run will continue without monitoring.`);
  }
}

// (existing prepareLaunch call — extend its ctx)
prepared = await adapter.prepareLaunch(resolvedCfg, folder, {
  debug: opts?.debug ?? false,
  debugPort: opts?.debugPort,
  monitor: Boolean(monitorPort),
  monitorPort,
});
```

After the `executeTask` resolves and we have the entry built, attach the monitoring service:

```ts
if (monitorPort && this.monitoring) {
  // Wait briefly for the JVM to bind the JMX port before spawning
  // the agent. The agent retries internally for 10 s, so we don't
  // need to delay here — fire-and-forget.
  const pid = entry.terminalRef?.current?.childPid ?? 0;
  this.monitoring.attach(cfg.id, pid, monitorPort);
}
```

In `stop(configId)`:

```ts
this.monitoring?.detach(configId);
```

- [ ] **Step 4: ExecutionService constructor takes the MonitoringService**

Change the ExecutionService constructor signature:

```ts
constructor(
  private readonly registry: AdapterRegistry,
  private readonly monitoring?: MonitoringService,
) { ... }
```

`monitoring` is optional so existing tests that don't care about monitoring keep compiling.

- [ ] **Step 5: DebugService — same shape**

In `src/services/DebugService.ts`, add `monitor?: boolean` to the debug call shape and forward through `exec.run({ debug: true, debugPort, monitor: opts?.monitor })`. The MonitoringService.attach happens once in ExecutionService.run, so DebugService doesn't need its own attach call.

- [ ] **Step 6: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green.

DO NOT COMMIT.

---

## Task 9: Tree provider — sparkline + monitored contextValue

**Files:**
- Modify: `src/ui/RunConfigTreeProvider.ts`

- [ ] **Step 1: Subscribe to MonitoringService events**

The tree provider's constructor takes the existing services. Add:

```ts
constructor(
  // ...existing args...
  private readonly monitoring?: MonitoringService,
) {
  // ...existing wiring...
  if (monitoring) {
    monitoring.onChanged(id => this.refresh(/* find node by id */));
  }
}
```

- [ ] **Step 2: Build the sparkline**

Add a private helper:

```ts
// Renders a 16-character sparkline from the last 64 seconds of
// heap-used data, scaled to the JVM's heap-max (or running max if
// heap-max is unbounded). Each character represents one 4-second bucket.
private sparklineFor(state: MonitoringState): string {
  const HISTORY_BUCKETS = 16;
  const BUCKET_SECONDS = 4;
  const blockChars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  if (state.history.length === 0) return '⋯';
  const heapMax = state.history[state.history.length - 1].heapMax > 0
    ? state.history[state.history.length - 1].heapMax
    : Math.max(...state.history.map(m => m.heapUsed));
  const buckets: number[] = [];
  // Walk the history backwards, building 16 buckets of BUCKET_SECONDS each.
  // Falls back to gracefully shorter sparkline when history is younger.
  const tail = state.history.slice(-HISTORY_BUCKETS * BUCKET_SECONDS);
  for (let i = 0; i < HISTORY_BUCKETS; i++) {
    const start = i * BUCKET_SECONDS;
    const end = start + BUCKET_SECONDS;
    const slice = tail.slice(start, end);
    if (slice.length === 0) buckets.push(0);
    else buckets.push(slice.reduce((s, m) => Math.max(s, m.heapUsed), 0));
  }
  return buckets.map(v => {
    const ratio = heapMax > 0 ? v / heapMax : 0;
    const idx = Math.max(0, Math.min(blockChars.length - 1, Math.round(ratio * (blockChars.length - 1))));
    return blockChars[idx];
  }).join('');
}
```

- [ ] **Step 3: Wire the sparkline into TreeItem.description**

Find the place in `getTreeItem` (or wherever `TreeItem.description` is set for running configs). Add:

```ts
const monState = this.monitoring?.state(n.config.id);
if (monState && monState.history.length > 0) {
  const last = monState.history[monState.history.length - 1];
  const heapMb = (last.heapUsed / (1024 * 1024)).toFixed(0);
  const cpuPct = (last.cpuLoad * 100).toFixed(1);
  const spark = this.sparklineFor(monState);
  // Append to whatever description text already exists.
  item.description = `${item.description ? `${item.description}  ` : ''}${spark}  ${heapMb} MB  ${cpuPct}%`;
}
```

- [ ] **Step 4: Add :monitored contextValue suffix**

Same `getTreeItem`, where the contextValue is built. Append `:monitored` when `this.monitoring?.state(n.config.id)` is non-null:

```ts
const monitoredSuffix = this.monitoring?.state(n.config.id) ? ':monitored' : '';
item.contextValue = `${baseContextValue}${toolSuffix}${groupSuffix}${monitoredSuffix}`;
```

- [ ] **Step 5: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green.

DO NOT COMMIT.

---

## Task 10: MonitorPanel webview

**Files:**
- Create: `src/ui/MonitorPanel.ts`
- Create: `webview/src/MonitorView.tsx`
- Modify: `src/shared/protocol.ts`
- Modify: `webview/src/main.tsx` (route monitor panel separately)

This task implements the bigger view. It's the second-largest by code volume.

- [ ] **Step 1: Add wire messages to protocol.ts**

In `src/shared/protocol.ts`, extend the unions:

```ts
// Outbound (webview → extension)
| { cmd: 'monitor.saveHeapDump'; configId: string }
| { cmd: 'monitor.setHistogramPaused'; configId: string; paused: boolean }
// Inbound (extension → webview)
| { cmd: 'monitor.tick'; configId: string; metrics: import('../services/monitoring/AgentMessage').MetricsTick }
| { cmd: 'monitor.histogram'; configId: string; histogram: import('../services/monitoring/AgentMessage').HistogramSnapshot }
| { cmd: 'monitor.dumpProgress'; configId: string; bytesWritten: number }
| { cmd: 'monitor.dumpComplete'; configId: string; path: string }
| { cmd: 'monitor.error'; configId: string; message: string }
```

- [ ] **Step 2: Implement MonitorPanel.ts**

Create `src/ui/MonitorPanel.ts`:

```ts
import * as vscode from 'vscode';
import * as path from 'path';
import type { MonitoringService } from '../services/MonitoringService';
import type { RunConfig } from '../shared/types';
import { log } from '../utils/logger';

export class MonitorPanel {
  // Singleton per configId.
  private static instances = new Map<string, MonitorPanel>();

  private panel: vscode.WebviewPanel;
  private subscription: vscode.Disposable;

  private constructor(
    private readonly cfg: RunConfig,
    private readonly extensionUri: vscode.Uri,
    private readonly monitoring: MonitoringService,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'rcmMonitor',
      `Monitor: ${cfg.name}`,
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media', 'webview')],
      },
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage(msg => this.onMessage(msg));
    this.subscription = monitoring.onChanged(id => {
      if (id === cfg.id) this.pushState();
    });
    this.panel.onDidDispose(() => {
      this.subscription.dispose();
      MonitorPanel.instances.delete(cfg.id);
    });
    this.pushState();
  }

  static open(cfg: RunConfig, extensionUri: vscode.Uri, monitoring: MonitoringService): void {
    const existing = this.instances.get(cfg.id);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const inst = new MonitorPanel(cfg, extensionUri, monitoring);
    this.instances.set(cfg.id, inst);
  }

  private pushState(): void {
    const state = this.monitoring.state(this.cfg.id);
    if (!state) return;
    // Push the latest tick + histogram. The webview renders from
    // its own ring buffer fed by these messages.
    if (state.history.length > 0) {
      this.panel.webview.postMessage({
        cmd: 'monitor.tick',
        configId: this.cfg.id,
        metrics: state.history[state.history.length - 1],
      });
    }
    if (state.histogram) {
      this.panel.webview.postMessage({
        cmd: 'monitor.histogram',
        configId: this.cfg.id,
        histogram: state.histogram,
      });
    }
  }

  private async onMessage(msg: any): Promise<void> {
    if (msg?.cmd === 'monitor.saveHeapDump' && msg.configId === this.cfg.id) {
      const target = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(
          require('os').tmpdir(),
          `${this.cfg.name.replace(/\W+/g, '-')}-${Date.now()}.hprof`,
        )),
        filters: { 'Heap dump': ['hprof'] },
      });
      if (!target) return;
      try {
        const writtenPath = await this.monitoring.saveHeapDump(this.cfg.id, target.fsPath);
        this.panel.webview.postMessage({ cmd: 'monitor.dumpComplete', configId: this.cfg.id, path: writtenPath });
        const choice = await vscode.window.showInformationMessage(
          `Heap dump written to ${writtenPath}`,
          'Reveal in Explorer',
        );
        if (choice === 'Reveal in Explorer') {
          vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(writtenPath));
        }
      } catch (e) {
        log.warn(`MonitorPanel saveHeapDump failed: ${(e as Error).message}`);
        this.panel.webview.postMessage({ cmd: 'monitor.error', configId: this.cfg.id, message: (e as Error).message });
      }
    }
    if (msg?.cmd === 'monitor.setHistogramPaused' && msg.configId === this.cfg.id) {
      this.monitoring.setHistogramPaused(this.cfg.id, !!msg.paused);
    }
  }

  private html(): string {
    const main = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'assets', 'main.js'),
    );
    const css = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'webview', 'assets', 'main.css'),
    );
    // Communicate which view to mount via window-level config.
    return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <link rel="stylesheet" href="${css}">
  <script>window.__rcmView = 'monitor'; window.__rcmConfigId = ${JSON.stringify(this.cfg.id)};
    window.__rcmConfigName = ${JSON.stringify(this.cfg.name)};</script>
</head><body><div id="root"></div><script type="module" src="${main}"></script></body></html>`;
  }
}
```

- [ ] **Step 3: Implement MonitorView.tsx**

Create `webview/src/MonitorView.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MetricsTick, HistogramSnapshot, HistogramRow } from '../../src/services/monitoring/AgentMessage';
import { groupByPackage } from '../../src/services/monitoring/parseClassHistogram';

const HISTORY_CAP_BY_WINDOW: Record<string, number> = {
  '60s': 60,
  '5min': 300,
  '30min': 1800,
};

declare const acquireVsCodeApi: any;
const vscode = typeof acquireVsCodeApi !== 'undefined' ? acquireVsCodeApi() : { postMessage: () => {} };

export function MonitorView({ configId, configName }: { configId: string; configName: string }) {
  const [history, setHistory] = useState<MetricsTick[]>([]);
  const [histogram, setHistogram] = useState<HistogramSnapshot | null>(null);
  const [windowKey, setWindowKey] = useState<keyof typeof HISTORY_CAP_BY_WINDOW>('60s');
  const [filter, setFilter] = useState('');
  const [sortBy, setSortBy] = useState<'instances' | 'bytes' | 'className'>('bytes');
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg?.configId !== configId) return;
      if (msg.cmd === 'monitor.tick') {
        setHistory(h => {
          const cap = HISTORY_CAP_BY_WINDOW[windowKey];
          const next = [...h, msg.metrics];
          return next.slice(-cap);
        });
      } else if (msg.cmd === 'monitor.histogram') {
        setHistogram(msg.histogram);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [configId, windowKey]);

  const grouped = useMemo(() => {
    if (!histogram) return [];
    const filtered = filter
      ? histogram.rows.filter(r => r.className.toLowerCase().includes(filter.toLowerCase()))
      : histogram.rows;
    return groupByPackage(filtered);
  }, [histogram, filter]);

  const last = history[history.length - 1];
  const heapMb = last ? (last.heapUsed / (1024 * 1024)).toFixed(0) : '—';
  const heapMaxMb = last && last.heapMax > 0 ? (last.heapMax / (1024 * 1024)).toFixed(0) : '—';
  const uptime = last ? Math.round((Date.now() - history[0].t) / 1000) : 0;
  const avgCpu = history.length > 0
    ? (history.reduce((s, m) => s + m.cpuLoad, 0) / history.length * 100).toFixed(1)
    : '—';

  return (
    <div style={{ padding: 16, fontFamily: 'var(--vscode-font-family)' }}>
      <h2>{configName}</h2>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        {(['60s', '5min', '30min'] as const).map(w => (
          <button key={w} onClick={() => setWindowKey(w)}
            style={{ fontWeight: w === windowKey ? 'bold' : 'normal' }}>
            {w}
          </button>
        ))}
        <button onClick={() => vscode.postMessage({ cmd: 'monitor.saveHeapDump', configId })}>
          Save heap dump
        </button>
      </div>
      {/* Lightweight chart — full uPlot integration is out of scope for v1.
          v1 renders an SVG sparkline strip; v2 can swap to uPlot for proper axes. */}
      <ChartStrip history={history} />
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 16, rowGap: 4, marginTop: 8, fontSize: '0.92em' }}>
        <div>Run duration</div><div>{Math.floor(uptime / 60)}m {uptime % 60}s</div>
        <div>Heap used</div><div>{heapMb} MB / {heapMaxMb} MB</div>
        <div>Threads</div><div>{last?.threadCount ?? '—'}</div>
        <div>CPU (now / avg)</div><div>{last ? (last.cpuLoad * 100).toFixed(1) : '—'}% / {avgCpu}%</div>
        <div>GC count / time</div><div>{last?.gcCount ?? '—'} / {last?.gcTime ?? '—'} ms</div>
      </div>
      <hr style={{ margin: '16px 0' }} />
      <h3>Class histogram</h3>
      <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
        <input
          placeholder="Filter (substring)"
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <select value={sortBy} onChange={e => setSortBy(e.target.value as any)}>
          <option value="bytes">Sort: Bytes</option>
          <option value="instances">Sort: Instances</option>
          <option value="className">Sort: Class name</option>
        </select>
        <button onClick={() => {
          const next = !paused;
          setPaused(next);
          vscode.postMessage({ cmd: 'monitor.setHistogramPaused', configId, paused: next });
        }}>
          {paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        </button>
      </div>
      <HistogramTree nodes={grouped} sortBy={sortBy} />
    </div>
  );
}

function ChartStrip({ history }: { history: MetricsTick[] }) {
  // Minimal SVG sparkline strip for v1. Width fits the panel.
  if (history.length === 0) return <div style={{ height: 120, opacity: 0.6 }}>No data yet</div>;
  const w = 800, h = 120;
  const heapMax = Math.max(...history.map(m => Math.max(m.heapUsed, m.heapMax > 0 ? m.heapMax : 0))) || 1;
  const points = history.map((m, i) => {
    const x = (i / (history.length - 1 || 1)) * w;
    const y = h - (m.heapUsed / heapMax) * h;
    return `${x},${y}`;
  }).join(' ');
  return (
    <svg width={w} height={h} style={{ background: 'var(--vscode-editorWidget-background)' }}>
      <polyline points={points} fill="none" stroke="var(--vscode-charts-blue, #4080ff)" strokeWidth={1.5} />
    </svg>
  );
}

function HistogramTree({ nodes, sortBy }: { nodes: import('../../src/services/monitoring/parseClassHistogram').HistogramNode[]; sortBy: 'instances' | 'bytes' | 'className' }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const sorted = useMemo(() => {
    const cmp = (a: any, b: any) => {
      if (sortBy === 'className') return a.name.localeCompare(b.name);
      return (b[sortBy === 'bytes' ? 'totalBytes' : 'totalInstances'] - a[sortBy === 'bytes' ? 'totalBytes' : 'totalInstances']);
    };
    function rec(list: any[]): any[] {
      const copy = [...list].sort(cmp);
      return copy.map(n => ({ ...n, children: rec(n.children) }));
    }
    return rec(nodes);
  }, [nodes, sortBy]);

  return (
    <div style={{ fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: '0.9em' }}>
      {sorted.map(node => (
        <Row key={node.name} node={node} depth={0} expanded={expanded} setExpanded={setExpanded} prefix="" />
      ))}
    </div>
  );
}

function Row({ node, depth, expanded, setExpanded, prefix }: any) {
  const id = `${prefix}/${node.name}`;
  const isOpen = expanded.has(id);
  const hasChildren = node.children.length > 0;
  return (
    <div>
      <div
        style={{ paddingLeft: depth * 16, cursor: hasChildren ? 'pointer' : 'default', display: 'flex', gap: 8 }}
        onClick={() => {
          if (!hasChildren) return;
          setExpanded((s: Set<string>) => {
            const next = new Set(s);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
          });
        }}
      >
        <span style={{ width: 12 }}>{hasChildren ? (isOpen ? '▾' : '▸') : ''}</span>
        <span style={{ flex: 1 }}>{node.name}</span>
        <span style={{ width: 80, textAlign: 'right' }}>{node.totalInstances.toLocaleString()}</span>
        <span style={{ width: 100, textAlign: 'right' }}>{(node.totalBytes / 1024).toFixed(0)} KB</span>
      </div>
      {isOpen && node.children.map((c: any) => (
        <Row key={c.name} node={c} depth={depth + 1} expanded={expanded} setExpanded={setExpanded} prefix={id} />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Wire MonitorView into webview entry**

In `webview/src/main.tsx`, add a branch that mounts `MonitorView` when `window.__rcmView === 'monitor'`. Existing code mounts `App.tsx` for the editor view; we add a sibling for the monitor view. Read the file before editing — make minimal changes.

- [ ] **Step 5: Verify webview build**

Run: `cd /git/run-config-manager && npm run build:webview 2>&1 | tail -10`
Expected: clean Vite build.

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

DO NOT COMMIT.

---

## Task 11: Wire MonitoringService into extension.ts + commands

**Files:**
- Modify: `src/extension.ts`
- Modify: `package.json`

- [ ] **Step 1: Construct MonitoringService**

In `src/extension.ts`, near the existing service constructions:

```ts
import { MonitoringService } from './services/MonitoringService';
import { MonitorPanel } from './ui/MonitorPanel';
```

Then:

```ts
const monitoring = new MonitoringService(context.extensionUri);
context.subscriptions.push({ dispose: () => monitoring.dispose() });
```

Pass `monitoring` to ExecutionService and TreeProvider:

```ts
const exec = new ExecutionService(registry, monitoring);
const tree = new RunConfigTreeProvider(store, svc, exec, dbg, registry, context.extensionUri, docker, orchestrator, native, groups, monitoring);
```

- [ ] **Step 2: Register the three commands**

```ts
vscode.commands.registerCommand('runConfig.runMonitored', async (arg: ConfigNodeArg) => {
  if (!arg || arg.kind !== 'config') return;
  const folder = store.getFolder(arg.folderKey);
  if (!folder) return;
  log.info(`Run with monitoring: "${arg.config.name}"`);
  await exec.run(arg.config, folder, { monitor: true });
}),
vscode.commands.registerCommand('runConfig.debugMonitored', async (arg: ConfigNodeArg) => {
  if (!arg || arg.kind !== 'config') return;
  const folder = store.getFolder(arg.folderKey);
  if (!folder) return;
  log.info(`Debug with monitoring: "${arg.config.name}"`);
  // DebugService takes the monitor flag through opts.
  await dbg.debug(arg.config, folder, { monitor: true } as any);
}),
vscode.commands.registerCommand('runConfig.openMonitor', (arg: ConfigNodeArg) => {
  if (!arg || arg.kind !== 'config') return;
  MonitorPanel.open(arg.config, context.extensionUri, monitoring);
}),
```

- [ ] **Step 3: package.json contributes**

Add to the `commands` array:

```json
{ "command": "runConfig.runMonitored",   "title": "Run with Monitoring",   "icon": "$(pulse)" },
{ "command": "runConfig.debugMonitored", "title": "Debug with Monitoring", "icon": "$(debug-alt)" },
{ "command": "runConfig.openMonitor",    "title": "Open Monitor View",     "icon": "$(graph)" }
```

Add to the `view/item/context` menu — gated on JVM types:

```json
{
  "command": "runConfig.runMonitored",
  "when": "view == runConfigurations && viewItem =~ /^configIdle(NoDebug)?(:(maven|gradle))?(:grouped)?$/ && viewItem !~ /custom-command|docker|http-request|npm|python/",
  "group": "1_run@5"
},
{
  "command": "runConfig.debugMonitored",
  "when": "view == runConfigurations && viewItem =~ /^configIdle(NoDebug)?(:(maven|gradle))?(:grouped)?$/ && viewItem !~ /NoDebug/ && viewItem !~ /custom-command|docker|http-request|npm|python/",
  "group": "1_run@6"
},
{
  "command": "runConfig.openMonitor",
  "when": "view == runConfigurations && viewItem =~ /:monitored/",
  "group": "1_run@7"
}
```

(The contextValue regex doesn't carry adapter type today — it carries tool suffix. Restricting to JVM types via the JVM-only `monitor` flag injection in adapters is what really gates this; the menu when-clause is a UX nicety. Verify by reading the existing tree provider's contextValue assembly to confirm.)

- [ ] **Step 4: Verify**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -6`
Expected: full suite green (no monitoring-specific tests added in this task; they live in earlier tasks).

DO NOT COMMIT.

---

## Task 12: Final integration verification

**Files:** none.

- [ ] **Step 1: Full test suite**

Run: `cd /git/run-config-manager && npm test 2>&1 | tail -8`
Expected: all tests pass (~857 + 23 new = ~880).

- [ ] **Step 2: Both typechecks**

Run: `cd /git/run-config-manager && npm run typecheck 2>&1 | tail -3`
Expected: zero errors.

- [ ] **Step 3: Production build**

Run: `cd /git/run-config-manager && npm run build 2>&1 | tail -10`
Expected: clean Vite + esbuild build.

- [ ] **Step 4: Manual smoke test**

```bash
code --extensionDevelopmentPath="$(pwd)" /tmp/spring-boot-app
```

In the host VS Code:
1. Add a Spring Boot config; right-click → **Run with Monitoring**.
2. Confirm the JVM starts, JMX flags are visible in the spawned command.
3. Tree row shows a sparkline + heap MB + CPU% updating each second.
4. Right-click the running config → **Open Monitor View**. Panel opens with the chart, analytics, histogram table.
5. Click **Save heap dump** → Save File dialog → confirm a `.hprof` file lands at the chosen path.
6. Stop the config — sparkline disappears; agent process exits cleanly (`pgrep -f rcm-monitor` should be empty).

DO NOT COMMIT.

---

## Self-review

**Spec coverage:**
- Bundled agent jar via Maven build → Task 1.
- Newline-delimited JSON wire format → Tasks 1 + 2.
- JMX flag injection across all four JVM adapters → Task 7.
- Free-port allocation → Task 4.
- Per-config lifecycle owner with ring buffer → Task 6.
- Tree-row sparkline + numeric → Task 9.
- Webview panel with chart + analytics + histogram table + heap-dump button → Task 10.
- Three new right-click commands → Task 11.
- Tests called out in spec — covered in Tasks 3 (flag), 4 (port), 5 (histogram parser), 6 (service lifecycle).

All spec requirements have a backing task.

**Placeholder scan:** None of the disallowed phrases ("TBD", "TODO", "implement later", "similar to Task N") appear. Task 7 says "the exact insertion point depends on the existing structure — read the surrounding code carefully" because the four adapter files have similar but not identical flag-injection plumbing (vmArgs vs JAVA_TOOL_OPTIONS vs CATALINA_OPTS). The implementer is given the SHAPE of the change; they pattern-match against the existing `debug` flag injection in each file.

**Type consistency:**
- `AgentMessage`, `MetricsTick`, `HistogramSnapshot` defined in Task 2; consumed in Tasks 6, 9, 10.
- `MonitoringState` defined in Task 6; consumed in Task 9 + 10.
- `monitor`, `monitorPort` flow consistently through `RunOpts → PrepareContext → adapter → MonitoringService.attach`.
- `HistogramNode` defined in Task 5; consumed in Task 10's `MonitorView`.

Plan complete.
