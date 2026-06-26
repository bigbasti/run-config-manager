'use strict';
// In-process monitoring agent. Loaded via NODE_OPTIONS=--require. Connects to
// the extension's localhost server (RCM_MONITOR_PORT) and streams NDJSON, one
// JSON document per line. Reads newline-delimited commands (`snapshot <path>`)
// from the same socket. Dependency-free. Never throws into the host app; never
// keeps the process alive (timers + socket are unref'd).
(function () {
  var PORT = parseInt(process.env.RCM_MONITOR_PORT || '', 10);
  var ID = process.env.RCM_MONITOR_ID || '';
  if (!PORT || !ID) return;

  var net, v8, perf;
  try { net = require('net'); v8 = require('v8'); perf = require('perf_hooks'); }
  catch (_) { return; }

  var startTime = Date.now();
  var socket = null, connected = false, buf = '';
  var lastCpu = process.cpuUsage(), lastCpuT = Date.now();
  var metricsTimer = null, spacesTimer = null, eld = null, gcObs = null;

  function round2(n) { return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0; }
  function safe(fn, fb) { try { return fn(); } catch (_) { return fb; } }
  function send(obj) {
    if (!socket || !connected) return;
    try { socket.write(JSON.stringify(obj) + '\n'); } catch (_) {}
  }

  function shallowEnv() {
    var out = {};
    try { Object.keys(process.env).forEach(function (k) { out[k] = String(process.env[k]); }); } catch (_) {}
    return out;
  }

  function gcKind(e) {
    var k = (e.detail && e.detail.kind != null) ? e.detail.kind : e.kind;
    var C = perf.constants || {};
    if (k === C.NODE_PERFORMANCE_GC_MINOR) return 'minor';
    if (k === C.NODE_PERFORMANCE_GC_MAJOR) return 'major';
    if (k === C.NODE_PERFORMANCE_GC_INCREMENTAL) return 'incremental';
    if (k === C.NODE_PERFORMANCE_GC_WEAKCB) return 'weakcb';
    return 'unknown';
  }

  function sampleMetrics() {
    var mem = safe(function () { return process.memoryUsage(); }, {});
    var hs = safe(function () { return v8.getHeapStatistics(); }, {});
    var now = Date.now();
    var cpu = process.cpuUsage(lastCpu);
    var elapsedMs = Math.max(1, now - lastCpuT);
    lastCpu = process.cpuUsage(); lastCpuT = now;
    var cpuPercent = ((cpu.user + cpu.system) / 1000) / elapsedMs * 100;
    var lag = eld
      ? { mean: eld.mean / 1e6, p50: eld.percentile(50) / 1e6, p99: eld.percentile(99) / 1e6, max: eld.max / 1e6 }
      : { mean: 0, p50: 0, p99: 0, max: 0 };
    if (eld) safe(function () { eld.reset(); });
    send({
      type: 'metrics', t: now,
      rss: mem.rss || 0, heapTotal: mem.heapTotal || 0, heapUsed: mem.heapUsed || 0,
      heapLimit: hs.heap_size_limit || 0, external: mem.external || 0, arrayBuffers: mem.arrayBuffers || 0,
      cpuPercent: round2(cpuPercent),
      uptime: safe(function () { return process.uptime(); }, 0),
      activeHandles: safe(function () { return process._getActiveHandles().length; }, 0),
      activeRequests: safe(function () { return process._getActiveRequests().length; }, 0),
      loopLagMean: round2(lag.mean), loopLagP50: round2(lag.p50),
      loopLagP99: round2(lag.p99), loopLagMax: round2(lag.max)
    });
  }

  function sampleSpaces() {
    var spaces = safe(function () { return v8.getHeapSpaceStatistics(); }, []);
    send({
      type: 'heapSpaces', t: Date.now(),
      spaces: spaces.map(function (s) {
        return { name: s.space_name, size: s.space_size, used: s.space_used_size, available: s.space_available_size };
      })
    });
  }

  function handleCommand(line) {
    var m = /^snapshot\s+(.+)$/.exec(line.trim());
    if (m) {
      var p = m[1];
      try { v8.writeHeapSnapshot(p); send({ type: 'snapshotComplete', path: p }); }
      catch (e) { send({ type: 'error', message: 'snapshot failed: ' + (e && e.message) }); }
    }
  }

  function startSampling() {
    send({
      type: 'hello', t: Date.now(), id: ID, pid: process.pid,
      ppid: safe(function () { return process.ppid; }, 0),
      nodeVersion: process.version, v8Version: (process.versions && process.versions.v8) || '',
      platform: process.platform, arch: process.arch, execPath: process.execPath,
      cwd: safe(function () { return process.cwd(); }, ''),
      argv: process.argv.slice(), env: shallowEnv(), startTime: startTime
    });
    try { eld = perf.monitorEventLoopDelay({ resolution: 20 }); eld.enable(); } catch (_) { eld = null; }
    try {
      gcObs = new perf.PerformanceObserver(function (list) {
        list.getEntries().forEach(function (e) {
          send({ type: 'gc', t: Date.now(), kind: gcKind(e), durationMs: round2(e.duration) });
        });
      });
      gcObs.observe({ entryTypes: ['gc'] });
    } catch (_) { gcObs = null; }
    metricsTimer = setInterval(sampleMetrics, 1000);
    spacesTimer = setInterval(sampleSpaces, 5000);
    if (metricsTimer.unref) metricsTimer.unref();
    if (spacesTimer.unref) spacesTimer.unref();
    sampleMetrics(); sampleSpaces();
  }

  function cleanup() {
    connected = false;
    if (metricsTimer) { clearInterval(metricsTimer); metricsTimer = null; }
    if (spacesTimer) { clearInterval(spacesTimer); spacesTimer = null; }
    try { if (gcObs) gcObs.disconnect(); } catch (_) {}
    try { if (eld) eld.disable(); } catch (_) {}
  }

  function connect() {
    try { socket = net.connect(PORT, '127.0.0.1'); } catch (_) { return; }
    if (socket.unref) socket.unref();
    socket.on('connect', function () { connected = true; safe(startSampling); });
    socket.on('data', function (d) {
      buf += d.toString('utf8');
      var i;
      while ((i = buf.indexOf('\n')) >= 0) {
        var line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line) safe(function () { handleCommand(line); });
      }
    });
    socket.on('error', cleanup);
    socket.on('close', cleanup);
  }

  connect();
})();
