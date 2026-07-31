const os = require('os');
const { execFile } = require('child_process');

const THRESHOLDS = { mem: 80, cpu: 70, gpu: 40 };

function memPercent() {
  const total = os.totalmem();
  if (!total) return 0;
  return ((total - os.freemem()) / total) * 100;
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const v of Object.values(c.times)) total += v;
    idle += c.times.idle;
  }
  return { idle, total };
}

function cpuPercent(sampleMs = 250) {
  return new Promise((resolve) => {
    const a = cpuTimes();
    setTimeout(() => {
      const b = cpuTimes();
      const idle = b.idle - a.idle;
      const total = b.total - a.total;
      resolve(total > 0 ? Math.max(0, (1 - idle / total) * 100) : 0);
    }, sampleMs);
  });
}

function run(cmd, args, timeout) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout));
    });
  });
}

// GPU is best-effort: Windows perf counter first, then nvidia-smi. Null if unknown.
async function gpuPercent() {
  if (process.platform === 'win32') {
    // Max engine utilization ≈ Task Manager's GPU %.
    const ps =
      "$ErrorActionPreference='SilentlyContinue';" +
      "$m=(Get-Counter '\\GPU Engine(*)\\Utilization Percentage').CounterSamples |" +
      ' Measure-Object -Property CookedValue -Maximum;' +
      ' if($m){[math]::Round($m.Maximum,0)}';
    const out = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], 5000);
    const v = out != null ? parseFloat(out.trim()) : NaN;
    if (Number.isFinite(v)) return Math.min(100, v);
  }
  // Fallback: NVIDIA GPUs on any platform.
  const smi = await run('nvidia-smi', ['--query-gpu=utilization.gpu', '--format=csv,noheader,nounits'], 5000);
  if (smi != null) {
    const v = parseFloat(smi.split('\n')[0].trim());
    if (Number.isFinite(v)) return v;
  }
  return null; // unknown — don't block on GPU
}

// Returns { busy, reason, mem, cpu, gpu }. Short-circuits on the first trip.
async function check() {
  const mem = memPercent();
  if (mem >= THRESHOLDS.mem) return { busy: true, reason: `RAM ${Math.round(mem)}%`, mem };

  const cpu = await cpuPercent();
  if (cpu >= THRESHOLDS.cpu) return { busy: true, reason: `CPU ${Math.round(cpu)}%`, mem, cpu };

  const gpu = await gpuPercent();
  if (gpu != null && gpu >= THRESHOLDS.gpu) return { busy: true, reason: `GPU ${Math.round(gpu)}%`, mem, cpu, gpu };

  return { busy: false, mem, cpu, gpu };
}

module.exports = { check, THRESHOLDS };
