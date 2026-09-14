// Session-scoped watchdog for the compatibility proxy.
//
// It health-checks the proxy on a fixed port and restarts it **on the same port** when it is gone,
// because running sessions keep the base_url they started with. It exits by itself once the Codex
// client is no longer running, so it never lingers after a session, and it is not registered
// anywhere in the system (no autostart, no scheduled task, no registry entry).
//
// usage:
//   node proxy-watchdog.mjs [--port 8899] [--interval-ms 10000] [--client-process ChatGPT]
//                           [--proxy-script <path>] [--proxy-log <path>] [--log <path>]
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const port = Number(argValue('--port', '8899'));
const intervalMs = Number(argValue('--interval-ms', '10000'));
const clientProcess = argValue('--client-process', 'ChatGPT');
const toolsDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const proxyScript = path.resolve(argValue('--proxy-script', path.join(toolsDir, 'deepseek-proxy.mjs')));
const proxyLog = argValue('--proxy-log', null);
const logPath = path.resolve(argValue('--log', path.join(os.homedir(), '.codex', 'proxy-watchdog.log')));
const lockPath = path.resolve(argValue('--lock', path.join(os.homedir(), '.codex', `proxy-watchdog-${port}.json`)));
const HEALTH_MARKER = 'codex-multiprovider-proxy';
const MAX_CONSECUTIVE_RESTART_FAILURES = 5;
// Missing checks tolerated before assuming the session is over (interval * this value).
const CLIENT_GONE_CHECKS = 2;

function log(message) {
  const line = `${new Date().toISOString()} port=${port} ${message}`;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, line + '\n');
  } catch { /* logging is best effort */ }
}

function writeLock() {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, port, updatedAt: Date.now(), proxyScript }));
  } catch { /* best effort */ }
}

function removeLock() {
  try { fs.unlinkSync(lockPath); } catch { /* best effort */ }
}

function proxyHealthy() {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/__proxy/health', timeout: 3000 }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed.ok === true && parsed.proxy === HEALTH_MARKER);
        } catch {
          resolve(false);
        }
      });
    });
    request.on('timeout', () => { request.destroy(); resolve(false); });
    request.on('error', () => resolve(false));
  });
}

function clientRunning() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      execFile('pgrep', ['-f', clientProcess], (error, stdout) => resolve(!error && stdout.trim().length > 0));
      return;
    }
    execFile('tasklist', ['/FI', `IMAGENAME eq ${clientProcess}.exe`, '/NH'], (error, stdout) => {
      if (error) {
        // Detection failure must not kill the watchdog; assume the session is alive.
        resolve(true);
        return;
      }
      resolve(stdout.toLowerCase().includes(`${clientProcess.toLowerCase()}.exe`));
    });
  });
}

let spawnedProxyPid = null;

async function restartProxy() {
  const proxyArgs = [proxyScript, '--port', String(port), '--downgrade-agent-messages'];
  if (proxyLog) proxyArgs.push('--log', proxyLog);
  try {
    const child = spawn(process.execPath, proxyArgs, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    // Remember what we started so the watchdog can take it down with the session. A proxy started
    // by the launcher instead is left alone.
    spawnedProxyPid = child.pid ?? null;
  } catch (error) {
    log(`restart_spawn_failed error=${error.message}`);
    return false;
  }
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (await proxyHealthy()) return true;
  }
  return false;
}

let stopping = false;
function stop(reason) {
  if (stopping) return;
  stopping = true;
  // Take down a proxy this watchdog started, so a session leaves nothing behind.
  if (spawnedProxyPid) {
    try {
      process.kill(spawnedProxyPid);
      log(`stopped_proxy pid=${spawnedProxyPid}`);
    } catch { /* already gone */ }
  }
  removeLock();
  log(`exit reason=${reason}`);
  process.exit(0);
}

process.on('SIGINT', () => stop('sigint'));
process.on('SIGTERM', () => stop('sigterm'));
process.on('uncaughtException', (error) => log(`uncaught_exception error=${error && error.message}`));
process.on('unhandledRejection', (error) => log(`unhandled_rejection error=${error && error.message}`));

let clientGoneChecks = 0;
let consecutiveFailures = 0;

writeLock();
log(`started intervalMs=${intervalMs} clientProcess=${clientProcess} proxy=${proxyScript}`);

for (;;) {
  writeLock();

  if (await proxyHealthy()) {
    consecutiveFailures = 0;
  } else {
    log('proxy_unhealthy restarting');
    const restarted = await restartProxy();
    if (restarted) {
      consecutiveFailures = 0;
      log('proxy_restarted');
    } else {
      consecutiveFailures += 1;
      log(`proxy_restart_failed consecutive=${consecutiveFailures}`);
      if (consecutiveFailures >= MAX_CONSECUTIVE_RESTART_FAILURES) {
        stop(`giving_up_after_${consecutiveFailures}_failures`);
      }
    }
  }

  if (await clientRunning()) {
    clientGoneChecks = 0;
  } else {
    clientGoneChecks += 1;
    if (clientGoneChecks >= CLIENT_GONE_CHECKS) {
      stop('client_not_running');
    }
  }

  await new Promise((resolve) => setTimeout(resolve, intervalMs));
}
