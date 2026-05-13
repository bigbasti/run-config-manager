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
    for (int i = 1; i < args.length; i++) {
      if (args[i].startsWith("--metrics-interval=")) {
        metricsIntervalMs = Integer.parseInt(args[i].substring("--metrics-interval=".length())) * 1000;
      } else if (args[i].startsWith("--histogram-interval=")) {
        histogramIntervalMs = Integer.parseInt(args[i].substring("--histogram-interval=".length())) * 1000;
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
    Thread at = new Thread(new ActuatorLoop(mbsc, 10_000), "rcm-actuator");
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
    String baseUrl = null;
    long lastAttempt = 0;
    boolean unavailableEmitted = false;
    ActuatorLoop(MBeanServerConnection m, int i) { this.mbsc = m; this.intervalMs = i; }

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

    // Tries server.port from -D args, then 8080.
    private String probeActuator() {
      java.util.Set<Integer> candidates = new java.util.LinkedHashSet<>();
      try {
        RuntimeMXBean rt = ManagementFactory.newPlatformMXBeanProxy(
          mbsc, "java.lang:type=Runtime", RuntimeMXBean.class);
        for (String a : rt.getInputArguments()) {
          java.util.regex.Matcher m = java.util.regex.Pattern.compile(
            "-D(?:management\\.server\\.port|server\\.port)=(\\d+)").matcher(a);
          if (m.find()) candidates.add(Integer.parseInt(m.group(1)));
        }
      } catch (Exception ignored) {}
      candidates.add(8080);
      candidates.add(8081);
      for (int port : candidates) {
        String base = "http://localhost:" + port + "/actuator";
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
        StringBuilder mb = new StringBuilder();
        mb.append("{\"type\":\"actuator\",\"t\":").append(System.currentTimeMillis())
          .append(",\"available\":true,\"baseUrl\":\"").append(jsonEscape(base)).append('"');
        if (health != null) mb.append(",\"health\":").append(health);
        if (reqCount != null) mb.append(",\"metrics\":").append(reqCount);
        if (tomcatJson != null) mb.append(",\"tomcat\":").append(tomcatJson);
        mb.append('}');
        System.out.println(mb.toString());
        System.out.flush();
      } catch (Exception e) {
        err("actuator emit failed: " + e.getMessage());
      }
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
      long total = 0;
      java.util.regex.Matcher m = java.util.regex.Pattern.compile(
        "\"statistic\":\"COUNT\",\"value\":(\\d+(?:\\.\\d+)?)").matcher(body);
      if (m.find()) total = (long) Double.parseDouble(m.group(1));
      return String.format(
        "{\"http_requests_total\":%d,\"http_request_duration_p50_ms\":0," +
        "\"http_request_duration_p95_ms\":0,\"http_request_duration_p99_ms\":0}", total);
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
