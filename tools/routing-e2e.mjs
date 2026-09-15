// End-to-end check of model-provider routing against a real codex.exe and a real CODEX_HOME.
// usage: node routing-e2e.mjs <codexExe> <codexHome>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [exe, codexHome] = process.argv.slice(2);
if (!exe || !codexHome) throw Error('usage: node routing-e2e.mjs <codexExe> <codexHome>');

const cwd = path.join(os.tmpdir(), `codex-routing-e2e-${process.pid}`);
mkdirSync(cwd, { recursive: true });
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
  if (process.env[key]) env[key] = process.env[key];
}
env.CODEX_HOME = codexHome;

const child = spawn(exe, ['app-server'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let stderr = '';
child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-4000); });
const pending = new Map();
let nextId = 0;
child.on('exit', (code) => { for (const p of pending.values()) p.reject(Error(`app-server exited ${code}`)); });
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.id != null && m.method) {
    child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'unexpected server request' } }) + '\n');
  }
});
const rpc = (method, params) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
};

const results = [];
try {
  await rpc('initialize', { clientInfo: { name: 'routing_e2e', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

  const models = await rpc('model/list', { includeHidden: false, cursor: null, limit: 100 });
  const slugs = models.data.map((m) => m.model);
  results.push(`model/list -> ${slugs.join(', ')}`);
  results.push(`deepseek visible: ${slugs.filter((s) => s.startsWith('deepseek-')).join(', ') || '(none)'}`);

  const common = { cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false };
  const routed = await rpc('thread/start', { ...common, model: 'deepseek-flash' });
  results.push(`thread/start(model=deepseek-flash, no provider) -> provider=${routed.modelProvider} model=${routed.model}`);

  // The desktop client's `create_thread` tool starts a delegated thread without naming a model, so
  // the config default decides the model and the route has to follow that decision.
  const defaulted = await rpc('thread/start', common);
  results.push(`thread/start(no model) -> provider=${defaulted.modelProvider} model=${defaulted.model}`);
  if (defaulted.model === 'deepseek-flash' && defaulted.modelProvider !== 'deepseek') {
    results.push('thread/start(no model) -> UNEXPECTEDLY NOT ROUTED');
    process.exitCode = 1;
  }

  const openai = await rpc('thread/start', { ...common, model: 'gpt-5.5' });
  results.push(`thread/start(model=gpt-5.5, no provider) -> provider=${openai.modelProvider} model=${openai.model}`);

  try {
    await rpc('thread/start', { ...common, model: 'deepseek-flash', modelProvider: 'openai' });
    results.push('thread/start(deepseek-flash on openai) -> UNEXPECTEDLY ACCEPTED');
  } catch (e) {
    results.push(`thread/start(deepseek-flash on openai) -> rejected: ${e.message}`);
  }

  try {
    await rpc('thread/start', { ...common, model: 'deepseek-flash', modelProvider: 'deepseek' });
    results.push('thread/start(deepseek-flash on deepseek) -> accepted');
  } catch (e) {
    results.push(`thread/start(deepseek-flash on deepseek) -> rejected: ${e.message}`);
  }
} catch (e) {
  results.push(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
console.log(results.join('\n'));
if (stderr.includes('ERROR')) console.log(`stderr tail: ${stderr.slice(-800)}`);
