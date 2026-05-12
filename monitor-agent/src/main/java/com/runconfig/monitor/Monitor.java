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
    Thread mt = new Thread(new MetricsLoop(mbsc, metricsIntervalMs), "rcm-metrics");
    mt.setDaemon(true);
    mt.start();
    Thread ht = new Thread(new HistogramLoop(mbsc, histogramIntervalMs), "rcm-histogram");
    ht.setDaemon(true);
    ht.start();

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
            System.out.println(String.format(
              "{\"type\":\"metrics\",\"t\":%d,\"heapUsed\":%d,\"heapCommitted\":%d," +
              "\"heapMax\":%d,\"nonHeapUsed\":%d,\"cpuLoad\":%.4f,\"threadCount\":%d," +
              "\"gcCount\":%d,\"gcTime\":%d}",
              t, heapUsed, heapCommitted, heapMax, nonHeapUsed, cpuLoad, threadCount, gcCount, gcTime));
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
