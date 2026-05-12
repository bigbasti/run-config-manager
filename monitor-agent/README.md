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
