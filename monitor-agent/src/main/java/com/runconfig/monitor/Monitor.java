package com.runconfig.monitor;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.management.GarbageCollectorMXBean;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.lang.management.OperatingSystemMXBean;
import java.lang.management.ThreadMXBean;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.ClassLoadingMXBean;
import java.lang.management.CompilationMXBean;
import java.lang.management.RuntimeMXBean;
import java.lang.management.BufferPoolMXBean;
import javax.management.MBeanServerConnection;
import javax.management.ObjectName;
import javax.management.remote.JMXConnector;
import javax.management.remote.JMXConnectorFactory;
import javax.management.remote.JMXServiceURL;
import com.sun.management.HotSpotDiagnosticMXBean;
import java.util.Locale;
import javax.management.Notification;
import javax.management.NotificationListener;
import com.sun.management.GarbageCollectionNotificationInfo;
import javax.management.openmbean.CompositeData;

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
    // Hint from the RCM config's `port` field — passed as --app-port=<N> by
    // MonitoringService so probeActuator() can prioritise the user-configured
    // port over the generic fallback scan.
    int appPort = 0;
    for (int i = 1; i < args.length; i++) {
      if (args[i].startsWith("--metrics-interval=")) {
        metricsIntervalMs = Integer.parseInt(args[i].substring("--metrics-interval=".length())) * 1000;
      } else if (args[i].startsWith("--histogram-interval=")) {
        histogramIntervalMs = Integer.parseInt(args[i].substring("--histogram-interval=".length())) * 1000;
      } else if (args[i].startsWith("--app-port=")) {
        try {
          appPort = Integer.parseInt(args[i].substring("--app-port=".length()));
        } catch (NumberFormatException ignored) {}
      }
    }

    JMXConnector jmxc = connectWithRetry(port, 10_000);
    MBeanServerConnection mbsc = jmxc.getMBeanServerConnection();

    // Emit one-time runtime info BEFORE starting periodic threads, so it's
    // the first non-metrics line on stdout.
    emitRuntimeInfo(mbsc);

    // Background timers for periodic emit.
    Thread mt = new Thread(new MetricsLoop(mbsc, metricsIntervalMs), "rcm-metrics");
    mt.setDaemon(true);
    mt.start();
    Thread ht = new Thread(new HistogramLoop(mbsc, histogramIntervalMs), "rcm-histogram");
    ht.setDaemon(true);
    ht.start();
    Thread tt = new Thread(new ThreadsLoop(mbsc, 5_000), "rcm-threads");
    tt.setDaemon(true);
    tt.start();
    ActuatorLoop actuatorLoop = new ActuatorLoop(mbsc, 10_000, appPort);
    Thread at = new Thread(actuatorLoop, "rcm-actuator");
    at.setDaemon(true);
    at.start();

    // Subscribe to per-collection GC events. The notification fires after
    // each collection completes — gives us cause, action, and the actual
    // duration. Polling getCollectionTime() can only show cumulative time.
    for (ObjectName gcName : mbsc.queryNames(new ObjectName("java.lang:type=GarbageCollector,*"), null)) {
      try {
        mbsc.addNotificationListener(gcName, new GcEventListener(), null, null);
      } catch (Exception e) {
        err("could not subscribe to GC notifications for " + gcName + ": " + e.getMessage());
      }
    }

    // Main thread: read stdin commands until EOF.
    try (BufferedReader r = new BufferedReader(new InputStreamReader(System.in))) {
      String line;
      while ((line = r.readLine()) != null) {
        line = line.trim();
        if (line.startsWith("dump ")) {
          String dumpPath = line.substring(5).trim();
          if (dumpPath.isEmpty()) {
            err("dump command requires a path");
          } else {
            handleDump(mbsc, dumpPath);
          }
        } else if (line.equals("histogram-pause")) {
          histogramPaused = true;
        } else if (line.equals("histogram-resume")) {
          histogramPaused = false;
        } else if (line.startsWith("thread-dump ")) {
          String tidStr = line.substring("thread-dump ".length()).trim();
          try {
            long tid = Long.parseLong(tidStr);
            handleThreadDump(mbsc, tid);
          } catch (NumberFormatException e) {
            err("thread-dump requires a numeric tid");
          }
        } else if (line.startsWith("set-log-level ")) {
          String[] parts = line.substring("set-log-level ".length()).trim().split("\\s+", 2);
          if (parts.length != 2) {
            err("set-log-level requires <name> <level>");
          } else {
            handleSetLogLevel(parts[0], parts[1]);
          }
        } else if (line.startsWith("set-actuator-url ")) {
          // User-provided override for the actuator base URL, e.g. when the
          // app is deployed under a non-root context path that the auto-probe
          // couldn't discover.
          String url = line.substring("set-actuator-url ".length()).trim();
          if (url.isEmpty()) {
            err("set-actuator-url requires a URL argument");
          } else {
            actuatorLoop.overrideUrl(url);
          }
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
        java.util.List<GarbageCollectorMXBean> gcBeans = new java.util.ArrayList<>();
        for (ObjectName gc : gcs) {
          gcBeans.add(ManagementFactory.newPlatformMXBeanProxy(
            mbsc, gc.toString(), GarbageCollectorMXBean.class));
        }
        ClassLoadingMXBean classLoading = ManagementFactory.newPlatformMXBeanProxy(
          mbsc, "java.lang:type=ClassLoading", ClassLoadingMXBean.class);
        CompilationMXBean compilation;
        try {
          compilation = ManagementFactory.newPlatformMXBeanProxy(
            mbsc, "java.lang:type=Compilation", CompilationMXBean.class);
        } catch (Exception ignored) {
          compilation = null;
        }
        java.util.List<MemoryPoolMXBean> poolBeans = new java.util.ArrayList<>();
        for (ObjectName pn : mbsc.queryNames(new ObjectName("java.lang:type=MemoryPool,*"), null)) {
          poolBeans.add(ManagementFactory.newPlatformMXBeanProxy(mbsc, pn.toString(), MemoryPoolMXBean.class));
        }
        java.util.List<BufferPoolMXBean> bufferBeans = new java.util.ArrayList<>();
        for (ObjectName pn : mbsc.queryNames(new ObjectName("java.nio:type=BufferPool,*"), null)) {
          bufferBeans.add(ManagementFactory.newPlatformMXBeanProxy(mbsc, pn.toString(), BufferPoolMXBean.class));
        }
        while (true) {
          try {
            long heapUsed = memory.getHeapMemoryUsage().getUsed();
            long heapCommitted = memory.getHeapMemoryUsage().getCommitted();
            long heapMax = memory.getHeapMemoryUsage().getMax();
            long nonHeapUsed = memory.getNonHeapMemoryUsage().getUsed();
            int threadCount = threads.getThreadCount();
            double cpuLoad = -1.0;
            try { cpuLoad = (Double) mbsc.getAttribute(osName, "ProcessCpuLoad"); }
            catch (Exception ignored) {}
            if (Double.isNaN(cpuLoad) || Double.isInfinite(cpuLoad)) cpuLoad = -1.0;
            long gcCount = 0, gcTime = 0;
            for (GarbageCollectorMXBean bean : gcBeans) {
              gcCount += bean.getCollectionCount();
              gcTime += bean.getCollectionTime();
            }
            long t = System.currentTimeMillis();
            // Hand-rolled JSON to avoid pulling in a JSON dep — tiny, fixed shape.
            StringBuilder mb = new StringBuilder();
            mb.append("{\"type\":\"metrics\",\"t\":").append(t)
              .append(",\"heapUsed\":").append(heapUsed)
              .append(",\"heapCommitted\":").append(heapCommitted)
              .append(",\"heapMax\":").append(heapMax)
              .append(",\"nonHeapUsed\":").append(nonHeapUsed)
              .append(",\"cpuLoad\":").append(String.format(Locale.ROOT, "%.4f", cpuLoad))
              .append(",\"threadCount\":").append(threadCount)
              .append(",\"gcCount\":").append(gcCount)
              .append(",\"gcTime\":").append(gcTime);

            // Memory pools
            try {
              mb.append(",\"pools\":{");
              boolean firstPool = true;
              for (MemoryPoolMXBean pool : poolBeans) {
                java.lang.management.MemoryUsage usage;
                try { usage = pool.getUsage(); } catch (Exception e) { continue; }
                if (usage == null) continue;
                if (!firstPool) mb.append(',');
                mb.append('"').append(jsonEscape(pool.getName())).append("\":{")
                  .append("\"used\":").append(usage.getUsed())
                  .append(",\"committed\":").append(usage.getCommitted())
                  .append(",\"max\":").append(usage.getMax())
                  .append('}');
                firstPool = false;
              }
              mb.append('}');
            } catch (Exception ignored) {}

            // Direct + mapped buffers
            try {
              for (BufferPoolMXBean bp : bufferBeans) {
                String key;
                if ("direct".equalsIgnoreCase(bp.getName())) key = "directBuffer";
                else if ("mapped".equalsIgnoreCase(bp.getName())) key = "mappedBuffer";
                else continue;
                mb.append(",\"").append(key).append("\":{")
                  .append("\"count\":").append(bp.getCount())
                  .append(",\"memoryUsed\":").append(bp.getMemoryUsed())
                  .append(",\"totalCapacity\":").append(bp.getTotalCapacity())
                  .append('}');
              }
            } catch (Exception ignored) {}

            // Class loading
            try {
              mb.append(",\"loadedClasses\":").append(classLoading.getLoadedClassCount())
                .append(",\"totalLoadedClasses\":").append(classLoading.getTotalLoadedClassCount())
                .append(",\"unloadedClasses\":").append(classLoading.getUnloadedClassCount());
            } catch (Exception ignored) {}

            // JIT compile time
            try {
              if (compilation != null && compilation.isCompilationTimeMonitoringSupported()) {
                mb.append(",\"compileTimeMs\":").append(compilation.getTotalCompilationTime());
              }
            } catch (Exception ignored) {}

            // File descriptors via com.sun.management.UnixOperatingSystemMXBean attrs
            try {
              Object oFd = mbsc.getAttribute(osName, "OpenFileDescriptorCount");
              Object mFd = mbsc.getAttribute(osName, "MaxFileDescriptorCount");
              if (oFd instanceof Number) mb.append(",\"openFds\":").append(((Number) oFd).longValue());
              if (mFd instanceof Number) mb.append(",\"maxFds\":").append(((Number) mFd).longValue());
            } catch (Exception ignored) {
              // Windows JVMs don't expose these — that's fine.
            }

            // System load + free physical / total physical / free swap
            try {
              Object load = mbsc.getAttribute(osName, "SystemLoadAverage");
              if (load instanceof Number) mb.append(",\"systemLoad\":").append(String.format(Locale.ROOT, "%.4f", ((Number) load).doubleValue()));
            } catch (Exception ignored) {}
            try {
              Object fpm = mbsc.getAttribute(osName, "FreePhysicalMemorySize");
              Object tpm = mbsc.getAttribute(osName, "TotalPhysicalMemorySize");
              Object fsw = mbsc.getAttribute(osName, "FreeSwapSpaceSize");
              if (fpm instanceof Number) mb.append(",\"freePhysicalMemory\":").append(((Number) fpm).longValue());
              if (tpm instanceof Number) mb.append(",\"totalPhysicalMemory\":").append(((Number) tpm).longValue());
              if (fsw instanceof Number) mb.append(",\"freeSwap\":").append(((Number) fsw).longValue());
            } catch (Exception ignored) {}

            mb.append('}');
            System.out.println(mb.toString());
            System.out.flush();
          } catch (Exception e) {
            err("metrics tick failed: " + e.getMessage());
          }
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
          }
          Thread.sleep(intervalMs);
        }
      } catch (Exception e) {
        err("histogram loop failed: " + e.getMessage());
      }
    }
  }

  private static class ThreadsLoop implements Runnable {
    final MBeanServerConnection mbsc;
    final int intervalMs;
    // Map<tid, lastCpuTime> for delta computation across ticks.
    final java.util.Map<Long, Long> lastCpuTime = new java.util.HashMap<>();
    ThreadsLoop(MBeanServerConnection m, int i) { this.mbsc = m; this.intervalMs = i; }

    public void run() {
      try {
        java.lang.management.ThreadMXBean threads = ManagementFactory.newPlatformMXBeanProxy(
          mbsc, "java.lang:type=Threading", java.lang.management.ThreadMXBean.class);
        // Enable CPU time tracking if supported.
        try {
          if (threads.isThreadCpuTimeSupported() && !threads.isThreadCpuTimeEnabled()) {
            threads.setThreadCpuTimeEnabled(true);
          }
        } catch (Exception ignored) {}

        while (true) {
          try {
            long t = System.currentTimeMillis();
            long[] tids = threads.getAllThreadIds();
            // Per-thread CPU + state. We sort by delta-cpu since last tick.
            java.util.Map<String, Integer> stateCounts = new java.util.HashMap<>();
            java.util.List<long[]> threadCpus = new java.util.ArrayList<>(); // [tid, deltaNs, totalNs]
            for (long tid : tids) {
              java.lang.management.ThreadInfo ti = threads.getThreadInfo(tid, 0);
              if (ti == null) continue;
              String state = ti.getThreadState().name();
              stateCounts.merge(state, 1, Integer::sum);
              long total = -1;
              try { total = threads.getThreadCpuTime(tid); } catch (Exception ignored) {}
              if (total < 0) continue;
              Long prev = lastCpuTime.get(tid);
              long delta = prev == null ? 0 : Math.max(0, total - prev);
              lastCpuTime.put(tid, total);
              threadCpus.add(new long[]{ tid, delta, total });
            }
            // Drop dead-thread entries from our cache.
            java.util.Set<Long> alive = new java.util.HashSet<>();
            for (long tid : tids) alive.add(tid);
            lastCpuTime.keySet().retainAll(alive);

            // Top 10 by delta.
            threadCpus.sort((a, b) -> Long.compare(b[1], a[1]));
            int topN = Math.min(10, threadCpus.size());
            StringBuilder topJson = new StringBuilder("[");
            // Track count of emitted entries (NOT loop index) — when a
            // thread terminates between getAllThreadIds() and getThreadInfo()
            // we skip it, and the comma logic must follow the actual output.
            int emitted = 0;
            for (int i = 0; i < topN; i++) {
              long[] row = threadCpus.get(i);
              java.lang.management.ThreadInfo ti = threads.getThreadInfo(row[0], 5);
              if (ti == null) continue;
              if (emitted > 0) topJson.append(',');
              emitted++;
              topJson.append("{\"id\":").append(row[0])
                     .append(",\"name\":\"").append(jsonEscape(ti.getThreadName())).append('"')
                     .append(",\"state\":\"").append(ti.getThreadState().name()).append('"')
                     .append(",\"cpuTimeNs\":").append(row[2])
                     .append(",\"cpuDeltaNs\":").append(row[1])
                     .append(",\"stackSnippet\":[");
              StackTraceElement[] st = ti.getStackTrace();
              for (int s = 0; s < st.length; s++) {
                if (s > 0) topJson.append(',');
                topJson.append('"').append(jsonEscape(st[s].toString())).append('"');
              }
              topJson.append("]}");
            }
            topJson.append(']');

            // States JSON.
            StringBuilder statesJson = new StringBuilder("{");
            boolean firstState = true;
            for (java.util.Map.Entry<String, Integer> e : stateCounts.entrySet()) {
              if (!firstState) statesJson.append(',');
              statesJson.append('"').append(e.getKey()).append("\":").append(e.getValue());
              firstState = false;
            }
            statesJson.append('}');

            // Deadlock detection.
            String deadlockJson = "null";
            try {
              long[] deadlocked = threads.findDeadlockedThreads();
              if (deadlocked != null && deadlocked.length > 0) {
                StringBuilder names = new StringBuilder("[");
                StringBuilder ids = new StringBuilder("[");
                for (int i = 0; i < deadlocked.length; i++) {
                  if (i > 0) { names.append(','); ids.append(','); }
                  java.lang.management.ThreadInfo ti = threads.getThreadInfo(deadlocked[i], 0);
                  names.append('"').append(jsonEscape(ti != null ? ti.getThreadName() : ("tid-" + deadlocked[i]))).append('"');
                  ids.append(deadlocked[i]);
                }
                names.append(']');
                ids.append(']');
                deadlockJson = String.format(
                  "{\"threadIds\":%s,\"names\":%s,\"summary\":\"%d threads deadlocked\"}",
                  ids, names, deadlocked.length);
              }
            } catch (Exception ignored) {}

            System.out.println(String.format(
              "{\"type\":\"threads\",\"t\":%d,\"states\":%s,\"topByCpu\":%s,\"deadlock\":%s}",
              t, statesJson, topJson, deadlockJson));
            System.out.flush();
          } catch (Exception e) {
            err("threads tick failed: " + e.getMessage());
          }
          Thread.sleep(intervalMs);
        }
      } catch (Exception e) {
        err("threads loop failed: " + e.getMessage());
      }
    }
  }

  private static class GcEventListener implements NotificationListener {
    public void handleNotification(Notification notification, Object handback) {
      if (!GarbageCollectionNotificationInfo.GARBAGE_COLLECTION_NOTIFICATION
          .equals(notification.getType())) return;
      try {
        GarbageCollectionNotificationInfo info = GarbageCollectionNotificationInfo.from(
          (CompositeData) notification.getUserData());
        long duration = info.getGcInfo().getDuration();
        long endTime = System.currentTimeMillis();
        System.out.println(String.format(
          "{\"type\":\"gc\",\"t\":%d,\"collector\":\"%s\",\"duration\":%d," +
          "\"cause\":\"%s\",\"action\":\"%s\",\"totalCount\":%d,\"totalTime\":%d}",
          endTime,
          jsonEscape(info.getGcName()),
          duration,
          jsonEscape(info.getGcCause()),
          jsonEscape(info.getGcAction()),
          info.getGcInfo().getId(),     // collection sequence id
          info.getGcInfo().getDuration() // duration is per-event; cumulative is in metrics
        ));
        System.out.flush();
      } catch (Exception e) {
        err("gc notification handler failed: " + e.getMessage());
      }
    }
  }

  // Stores the actuator base URL once probed so set-log-level works
  // without re-detecting. Updated by ActuatorLoop after a successful probe.
  private static volatile String actuatorBaseUrl = null;

  private static void emitRuntimeInfo(MBeanServerConnection mbsc) {
    try {
      RuntimeMXBean rt = ManagementFactory.newPlatformMXBeanProxy(
        mbsc, "java.lang:type=Runtime", RuntimeMXBean.class);
      StringBuilder mb = new StringBuilder();
      mb.append("{\"type\":\"runtime\",\"t\":").append(System.currentTimeMillis())
        .append(",\"vendor\":\"").append(jsonEscape(rt.getVmVendor())).append('"')
        .append(",\"vmName\":\"").append(jsonEscape(rt.getVmName())).append('"')
        .append(",\"version\":\"").append(jsonEscape(rt.getVmVersion())).append('"')
        .append(",\"pid\":").append(parsePid(rt.getName()))
        .append(",\"startTime\":").append(rt.getStartTime())
        .append(",\"inputArgs\":[");
      boolean first = true;
      for (String a : rt.getInputArguments()) {
        if (!first) mb.append(',');
        mb.append('"').append(jsonEscape(a)).append('"');
        first = false;
      }
      mb.append("],\"systemProperties\":{");
      first = true;
      for (java.util.Map.Entry<String, String> e : rt.getSystemProperties().entrySet()) {
        if (!first) mb.append(',');
        mb.append('"').append(jsonEscape(e.getKey())).append("\":\"")
          .append(jsonEscape(e.getValue())).append('"');
        first = false;
      }
      mb.append("},\"environment\":{");
      // Environment is the agent's own env (System.getenv()), which the agent
      // typically inherits from its parent. The target JVM's env can't be
      // read from outside without a JMX bridge — informational only.
      first = true;
      for (java.util.Map.Entry<String, String> e : System.getenv().entrySet()) {
        if (!first) mb.append(',');
        mb.append('"').append(jsonEscape(e.getKey())).append("\":\"")
          .append(jsonEscape(e.getValue())).append('"');
        first = false;
      }
      mb.append("}}");
      System.out.println(mb.toString());
      System.out.flush();
    } catch (Exception e) {
      err("runtime info emission failed: " + e.getMessage());
    }
  }

  private static long parsePid(String runtimeName) {
    // Format is "pid@host". Parse defensively.
    int at = runtimeName.indexOf('@');
    if (at <= 0) return -1;
    try { return Long.parseLong(runtimeName.substring(0, at)); } catch (Exception ignored) { return -1; }
  }

  private static class ActuatorLoop implements Runnable {
    final MBeanServerConnection mbsc;
    final int intervalMs;
    // RCM config port hint — 0 means not set. Highest-priority candidate in probeActuator().
    final int appPort;
    // volatile so the main stdin thread can set it via overrideUrl().
    volatile String baseUrl = null;
    long lastAttempt = 0;
    boolean unavailableEmitted = false;
    // /actuator/env and /actuator/info are large and change rarely.
    // We fetch them on the first successful snapshot, then every 60s.
    long lastStaticFetch = 0;
    ActuatorLoop(MBeanServerConnection m, int i, int appPort) {
      this.mbsc = m; this.intervalMs = i; this.appPort = appPort;
    }

    // Called from the main stdin thread when the user provides a manual URL
    // override from the UI. Sets baseUrl directly (skipping the auto-probe)
    // and resets state so an actuator snapshot is emitted on the next tick.
    void overrideUrl(String url) {
      this.baseUrl = url;
      // Update the shared static so handleSetLogLevel can use the new URL too.
      actuatorBaseUrl = url;
      // Reset the static-fetch timestamp so env/info are refreshed immediately.
      this.lastStaticFetch = 0;
      // Wake the loop by interrupting its sleep — it will pick up the new
      // baseUrl on the next iteration without waiting the full interval.
      // (Interrupting a sleeping daemon thread is safe; the loop catches
      //  InterruptedException and returns, but here we re-set the interrupt
      //  so the loop just exits the sleep and continues.)
      Thread.currentThread().interrupt(); // no-op when called from main thread
      // Emit immediately from the calling thread so the UI updates without
      // waiting for the next 10 s tick.
      try {
        emitActuatorSnapshot(url);
      } catch (Exception e) {
        err("overrideUrl snapshot failed: " + e.getMessage());
      }
    }

    public void run() {
      try { Thread.sleep(2_000); } catch (InterruptedException ignored) {}
      while (true) {
        try {
          if (baseUrl == null) {
            long now = System.currentTimeMillis();
            // Retry probe at startup, then every 60s if still missing.
            if (!unavailableEmitted || now - lastAttempt > 60_000) {
              baseUrl = probeActuator();
              lastAttempt = now;
              if (baseUrl == null) {
                if (!unavailableEmitted) {
                  System.out.println(String.format(
                    "{\"type\":\"actuator\",\"t\":%d,\"available\":false,\"reason\":\"no actuator endpoint at known ports\"}",
                    System.currentTimeMillis()));
                  System.out.flush();
                  unavailableEmitted = true;
                }
              } else {
                actuatorBaseUrl = baseUrl;
              }
            }
          }
          if (baseUrl != null) {
            emitActuatorSnapshot(baseUrl);
          }
        } catch (Exception e) {
          err("actuator tick failed: " + e.getMessage());
        }
        try { Thread.sleep(intervalMs); } catch (InterruptedException ie) {
          Thread.currentThread().interrupt();
          return;
        }
      }
    }

    // Discovers the Spring Boot Actuator base URL by probing candidate ports.
    //
    // Priority order:
    //   1. RCM config port hint (--app-port arg) — the user already configured
    //      the app port in the run config, so trust it first.
    //   2. JVM system properties: Spring Boot sets server.port /
    //      management.server.port as system properties at startup, which are
    //      readable via JMX. This covers ports declared in application.properties
    //      or application.yml without a -D flag.
    //   3. JVM -D input arguments: explicit -Dserver.port=N / -Dmanagement.server.port=N.
    //   4. Broad fallback list covering the most common Java server ports.
    private String probeActuator() {
      java.util.Set<Integer> candidates = new java.util.LinkedHashSet<>();

      // Priority 1: RCM config port hint.
      if (appPort > 0) candidates.add(appPort);

      try {
        RuntimeMXBean rt = ManagementFactory.newPlatformMXBeanProxy(
          mbsc, "java.lang:type=Runtime", RuntimeMXBean.class);

        // Priority 2: system properties (Spring sets these at startup).
        try {
          java.util.Map<String, String> sysProps = rt.getSystemProperties();
          for (String key : new String[]{"management.server.port", "server.port"}) {
            String v = sysProps.get(key);
            if (v != null && !v.isEmpty()) {
              try { candidates.add(Integer.parseInt(v.trim())); } catch (NumberFormatException ignored) {}
            }
          }
        } catch (Exception ignored) {}

        // Priority 3: explicit -D JVM arguments.
        for (String a : rt.getInputArguments()) {
          java.util.regex.Matcher m = java.util.regex.Pattern.compile(
            "-D(?:management\\.server\\.port|server\\.port)=(\\d+)").matcher(a);
          if (m.find()) {
            try { candidates.add(Integer.parseInt(m.group(1))); } catch (NumberFormatException ignored) {}
          }
        }
      } catch (Exception ignored) {}

      // Priority 4: broad fallback covering the most common Java server ports.
      for (int p : new int[]{8080, 8081, 8082, 8181, 8443, 9090}) candidates.add(p);

      for (int p : candidates) {
        String base = "http://localhost:" + p + "/actuator";
        try {
          java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
            new java.net.URL(base).openConnection();
          conn.setConnectTimeout(500);
          conn.setReadTimeout(500);
          if (conn.getResponseCode() == 200) return base;
        } catch (Exception ignored) {}
      }
      return null;
    }

    private void emitActuatorSnapshot(String base) {
      try {
        String health = httpGet(base + "/health");
        String reqCount = readMetric(base, "http.server.requests");
        String tomcatJson = readTomcatMBeans();
        String loggersJson = readLoggers(base + "/loggers");

        // Fetch env and info only on first snapshot and every 60s — they are
        // large payloads that change rarely and don't need per-tick updates.
        String envJson = null;
        String infoJson = null;
        long now = System.currentTimeMillis();
        if (now - lastStaticFetch > 60_000) {
          envJson = readEnv(base + "/env");
          infoJson = httpGet(base + "/info"); // pass raw JSON through
          lastStaticFetch = now;
        }

        StringBuilder mb = new StringBuilder();
        mb.append("{\"type\":\"actuator\",\"t\":").append(System.currentTimeMillis())
          .append(",\"available\":true,\"baseUrl\":\"").append(jsonEscape(base)).append('"');
        if (health != null) mb.append(",\"health\":").append(health);
        if (reqCount != null) mb.append(",\"metrics\":").append(reqCount);
        if (tomcatJson != null) mb.append(",\"tomcat\":").append(tomcatJson);
        if (loggersJson != null) mb.append(",\"loggers\":").append(loggersJson);
        if (envJson != null) mb.append(",\"env\":").append(envJson);
        if (infoJson != null && !infoJson.trim().equals("{}")) mb.append(",\"info\":").append(infoJson);
        mb.append('}');
        System.out.println(mb.toString());
        System.out.flush();
      } catch (Exception e) {
        err("actuator emit failed: " + e.getMessage());
      }
    }

    // Fetches /actuator/env and converts it to an array of property sources.
    // Spring Boot /actuator/env response shape:
    //   {"activeProfiles":[...],"propertySources":[
    //     {"name":"...","properties":{"key":{"value":"val","origin":"..."},...}},
    //     ...
    //   ]}
    // Returns a JSON array matching ActuatorEnvSource[] or null if not available.
    private String readEnv(String url) {
      String body = httpGet(url);
      if (body == null) return null;
      // Find "propertySources" array and pass it through verbatim.
      int idx = body.indexOf("\"propertySources\":");
      if (idx < 0) return null;
      int arrStart = body.indexOf('[', idx + "\"propertySources\":".length());
      if (arrStart < 0) return null;
      // Find matching closing bracket.
      int depth = 0;
      for (int i = arrStart; i < body.length(); i++) {
        char c = body.charAt(i);
        if (c == '[' || c == '{') depth++;
        else if (c == ']' || c == '}') { depth--; if (depth == 0) return body.substring(arrStart, i + 1); }
      }
      return null;
    }

    // Fetches /actuator/loggers and returns a JSON array of
    // {"name":"...","configured":null|"LEVEL","effective":"LEVEL"} objects,
    // or null if the endpoint is not available or returns no loggers.
    //
    // Spring Boot /actuator/loggers response shape:
    //   {"levels":[...],"loggers":{"name":{"configuredLevel":null,"effectiveLevel":"INFO"},...}}
    //
    // We hand-parse to avoid any JSON library dependency.
    private String readLoggers(String url) {
      String body = httpGet(url);
      if (body == null) return null;

      // Find the "loggers" object — everything between the first '{' after '"loggers":'
      int loggersIdx = body.indexOf("\"loggers\":");
      if (loggersIdx < 0) return null;
      int objStart = body.indexOf('{', loggersIdx + "\"loggers\":".length());
      if (objStart < 0) return null;

      // Walk character by character to find the matching closing brace.
      int depth = 0;
      int objEnd = -1;
      for (int i = objStart; i < body.length(); i++) {
        char c = body.charAt(i);
        if (c == '{') depth++;
        else if (c == '}') { depth--; if (depth == 0) { objEnd = i; break; } }
      }
      if (objEnd < 0) return null;

      String loggersObj = body.substring(objStart + 1, objEnd);
      // loggersObj now looks like:
      //   "com.example":{"configuredLevel":null,"effectiveLevel":"INFO"},...

      StringBuilder result = new StringBuilder("[");
      boolean first = true;

      // Split on top-level entries. Each entry is: "<name>":{...}
      // We iterate by finding quoted logger names followed by :{...}.
      int pos = 0;
      while (pos < loggersObj.length()) {
        // Skip whitespace and commas between entries.
        while (pos < loggersObj.length() && (loggersObj.charAt(pos) == ',' || loggersObj.charAt(pos) == ' ' || loggersObj.charAt(pos) == '\n' || loggersObj.charAt(pos) == '\r' || loggersObj.charAt(pos) == '\t')) pos++;
        if (pos >= loggersObj.length()) break;
        if (loggersObj.charAt(pos) != '"') break;

        // Read the logger name string.
        int nameStart = pos + 1;
        int nameEnd = nameStart;
        while (nameEnd < loggersObj.length()) {
          char c = loggersObj.charAt(nameEnd);
          if (c == '\\') { nameEnd += 2; continue; }
          if (c == '"') break;
          nameEnd++;
        }
        if (nameEnd >= loggersObj.length()) break;
        String loggerName = loggersObj.substring(nameStart, nameEnd);
        pos = nameEnd + 1; // skip closing quote

        // Skip colon.
        while (pos < loggersObj.length() && loggersObj.charAt(pos) != '{') pos++;
        if (pos >= loggersObj.length()) break;

        // Find the value object boundaries.
        int valStart = pos;
        int valDepth = 0;
        int valEnd = -1;
        for (int i = valStart; i < loggersObj.length(); i++) {
          char c = loggersObj.charAt(i);
          if (c == '{') valDepth++;
          else if (c == '}') { valDepth--; if (valDepth == 0) { valEnd = i; break; } }
        }
        if (valEnd < 0) break;
        String valObj = loggersObj.substring(valStart + 1, valEnd);
        pos = valEnd + 1;

        // Extract configuredLevel and effectiveLevel from the value object.
        String configured = extractStringField(valObj, "configuredLevel");
        String effective = extractStringField(valObj, "effectiveLevel");
        if (effective == null) effective = ""; // shouldn't happen but guard

        if (!first) result.append(',');
        first = false;
        result.append("{\"name\":\"").append(jsonEscape(loggerName)).append('"');
        if (configured == null || configured.equals("null")) {
          result.append(",\"configured\":null");
        } else {
          result.append(",\"configured\":\"").append(jsonEscape(configured)).append('"');
        }
        result.append(",\"effective\":\"").append(jsonEscape(effective)).append("\"}");
      }

      result.append(']');
      return first ? null : result.toString(); // null if no loggers were parsed
    }

    // Extracts the value of a JSON string field (handles null literals too).
    // Returns null for JSON null, the string value for string values,
    // or null if the field is not present.
    private String extractStringField(String obj, String field) {
      String key = "\"" + field + "\"";
      int idx = obj.indexOf(key);
      if (idx < 0) return null;
      int colon = obj.indexOf(':', idx + key.length());
      if (colon < 0) return null;
      int valStart = colon + 1;
      while (valStart < obj.length() && (obj.charAt(valStart) == ' ' || obj.charAt(valStart) == '\t')) valStart++;
      if (valStart >= obj.length()) return null;
      char first = obj.charAt(valStart);
      if (first == 'n') return "null"; // JSON null
      if (first != '"') return null;   // unexpected
      int strStart = valStart + 1;
      int strEnd = strStart;
      while (strEnd < obj.length()) {
        char c = obj.charAt(strEnd);
        if (c == '\\') { strEnd += 2; continue; }
        if (c == '"') break;
        strEnd++;
      }
      return obj.substring(strStart, strEnd);
    }

    private String httpGet(String url) {
      try {
        java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
          new java.net.URL(url).openConnection();
        conn.setConnectTimeout(1_000);
        conn.setReadTimeout(2_000);
        if (conn.getResponseCode() != 200) return null;
        try (java.io.BufferedReader r = new java.io.BufferedReader(
            new java.io.InputStreamReader(conn.getInputStream(), java.nio.charset.StandardCharsets.UTF_8))) {
          StringBuilder sb = new StringBuilder();
          String line;
          while ((line = r.readLine()) != null) sb.append(line);
          return sb.toString();
        }
      } catch (Exception e) {
        return null;
      }
    }

    private String readMetric(String base, String name) {
      String body = httpGet(base + "/metrics/" + name);
      if (body == null) return null;

      // Extract COUNT.
      long total = 0;
      java.util.regex.Matcher cm = java.util.regex.Pattern.compile(
        "\"statistic\":\"COUNT\",\"value\":(\\d+(?:\\.\\d+)?)").matcher(body);
      if (cm.find()) total = (long) Double.parseDouble(cm.group(1));

      // Best-effort extraction of PERCENTILE measurements.
      // Spring Boot publishes these when management.metrics.distribution
      // .percentiles-histogram.http.server.requests=true is configured, or
      // when explicit percentiles are set via
      // management.metrics.distribution.percentiles.http.server.requests=0.5,0.95,0.99
      //
      // The measurement entries look like:
      //   {"statistic":"PERCENTILE","value":0.042,"tags":[{"tag":"phi","values":["0.5"]}]}
      // or in the older format produced by Micrometer:
      //   {"statistic":"PERCENTILE","value":0.042}   (one entry per percentile, order matches
      //   the configured list — we can't rely on order, so we look for tag hints or accept
      //   all PERCENTILE values and pick p50/p95/p99 if exactly 3 are present).
      //
      // We also try the tag-filtered endpoint as a more reliable path.
      double p50 = 0, p95 = 0, p99 = 0;

      // Try tag-filtered endpoints first (most reliable — works when percentile
      // histogram is enabled).
      String p50Body = httpGet(base + "/metrics/" + name + "?tag=quantile:0.5");
      String p95Body = httpGet(base + "/metrics/" + name + "?tag=quantile:0.95");
      String p99Body = httpGet(base + "/metrics/" + name + "?tag=quantile:0.99");
      if (p50Body != null) p50 = extractFirstValue(p50Body) * 1000.0; // convert s -> ms
      if (p95Body != null) p95 = extractFirstValue(p95Body) * 1000.0;
      if (p99Body != null) p99 = extractFirstValue(p99Body) * 1000.0;

      // If tag-filtered endpoints returned nothing, fall back to parsing PERCENTILE
      // measurements from the base response.
      if (p50 == 0 && p95 == 0 && p99 == 0) {
        java.util.regex.Matcher pm = java.util.regex.Pattern.compile(
          "\"statistic\":\"PERCENTILE\",\"value\":(\\d+(?:\\.\\d+)?)").matcher(body);
        java.util.List<Double> percs = new java.util.ArrayList<>();
        while (pm.find()) percs.add(Double.parseDouble(pm.group(1)));
        // Micrometer typically emits p50, p95, p99 in that order when
        // management.metrics.distribution.percentiles is configured.
        if (percs.size() >= 3) {
          p50 = percs.get(0) * 1000.0;
          p95 = percs.get(1) * 1000.0;
          p99 = percs.get(2) * 1000.0;
        } else if (percs.size() == 1) {
          p50 = percs.get(0) * 1000.0;
        }
      }

      return String.format(
        "{\"http_requests_total\":%d,\"http_request_duration_p50_ms\":%.1f," +
        "\"http_request_duration_p95_ms\":%.1f,\"http_request_duration_p99_ms\":%.1f}",
        total, p50, p95, p99);
    }

    // Extracts the first numeric "value" from a Spring Actuator metrics response.
    private double extractFirstValue(String body) {
      if (body == null) return 0;
      java.util.regex.Matcher m = java.util.regex.Pattern.compile(
        "\"value\":(\\d+(?:\\.\\d+)?)").matcher(body);
      return m.find() ? Double.parseDouble(m.group(1)) : 0;
    }

    private String readTomcatMBeans() {
      try {
        java.util.Set<ObjectName> tps = mbsc.queryNames(new ObjectName("Catalina:type=ThreadPool,*"), null);
        if (tps.isEmpty()) return null;
        ObjectName tp = tps.iterator().next();
        Object busy = mbsc.getAttribute(tp, "currentThreadsBusy");
        Object max = mbsc.getAttribute(tp, "maxThreads");
        java.util.Set<ObjectName> grp = mbsc.queryNames(new ObjectName("Catalina:type=GlobalRequestProcessor,*"), null);
        long requestCount = 0, errorCount = 0;
        for (ObjectName g : grp) {
          Object rc = mbsc.getAttribute(g, "requestCount");
          Object ec = mbsc.getAttribute(g, "errorCount");
          if (rc instanceof Number) requestCount += ((Number) rc).longValue();
          if (ec instanceof Number) errorCount += ((Number) ec).longValue();
        }
        return String.format(
          "{\"currentThreadsBusy\":%d,\"maxThreads\":%d,\"requestCount\":%d,\"errorCount\":%d}",
          ((Number) busy).intValue(), ((Number) max).intValue(), requestCount, errorCount);
      } catch (Exception e) {
        return null;
      }
    }
  }

  private static void handleThreadDump(MBeanServerConnection mbsc, long tid) {
    try {
      java.lang.management.ThreadMXBean threads = ManagementFactory.newPlatformMXBeanProxy(
        mbsc, "java.lang:type=Threading", java.lang.management.ThreadMXBean.class);
      java.lang.management.ThreadInfo ti = threads.getThreadInfo(tid, Integer.MAX_VALUE);
      if (ti == null) {
        err("thread " + tid + " not found");
        return;
      }
      StringBuilder mb = new StringBuilder();
      mb.append("{\"type\":\"threadDump\",\"t\":").append(System.currentTimeMillis())
        .append(",\"tid\":").append(tid)
        .append(",\"name\":\"").append(jsonEscape(ti.getThreadName())).append('"')
        .append(",\"state\":\"").append(ti.getThreadState().name()).append('"')
        .append(",\"stack\":[");
      StackTraceElement[] st = ti.getStackTrace();
      for (int i = 0; i < st.length; i++) {
        if (i > 0) mb.append(',');
        mb.append('"').append(jsonEscape(st[i].toString())).append('"');
      }
      mb.append("]}");
      System.out.println(mb.toString());
      System.out.flush();
    } catch (Exception e) {
      err("thread-dump failed: " + e.getMessage());
    }
  }

  private static void handleSetLogLevel(String name, String level) {
    if (actuatorBaseUrl == null) {
      System.out.println(String.format(
        "{\"type\":\"logLevelChanged\",\"t\":%d,\"name\":\"%s\",\"level\":\"%s\",\"ok\":false," +
        "\"errorMessage\":\"actuator not available\"}",
        System.currentTimeMillis(), jsonEscape(name), jsonEscape(level)));
      System.out.flush();
      return;
    }
    try {
      java.net.HttpURLConnection conn = (java.net.HttpURLConnection)
        new java.net.URL(actuatorBaseUrl + "/loggers/" + java.net.URLEncoder.encode(name, "UTF-8"))
          .openConnection();
      conn.setRequestMethod("POST");
      conn.setRequestProperty("Content-Type", "application/json");
      conn.setDoOutput(true);
      String body = String.format("{\"configuredLevel\":\"%s\"}", jsonEscape(level));
      conn.getOutputStream().write(body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
      int code = conn.getResponseCode();
      boolean ok = code >= 200 && code < 300;
      System.out.println(String.format(
        "{\"type\":\"logLevelChanged\",\"t\":%d,\"name\":\"%s\",\"level\":\"%s\",\"ok\":%s," +
        "\"errorMessage\":\"%s\"}",
        System.currentTimeMillis(), jsonEscape(name), jsonEscape(level), ok,
        ok ? "" : ("HTTP " + code)));
      System.out.flush();
    } catch (Exception e) {
      System.out.println(String.format(
        "{\"type\":\"logLevelChanged\",\"t\":%d,\"name\":\"%s\",\"level\":\"%s\",\"ok\":false," +
        "\"errorMessage\":\"%s\"}",
        System.currentTimeMillis(), jsonEscape(name), jsonEscape(level), jsonEscape(e.getMessage())));
      System.out.flush();
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
