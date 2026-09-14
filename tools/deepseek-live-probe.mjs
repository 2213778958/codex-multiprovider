// Live DeepSeek reachability probe: does the provider endpoint accept the Responses wire API?
// Uses a deliberately invalid key unless DEEPSEEK_API_KEY is set, so it never needs a real credential.
// usage: node deepseek-live-probe.mjs <codexExe> <codexHome>
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [exe, codexHome] = process.argv.slice(2);
if (!exe || !codexHome) throw Error('usage: node deepseek-live-probe.mjs <codexExe> <codexHome>');

const cwd = path.join(os.tmpdir(), `codex-deepseek-probe-${process.pid}`);
mkdirSync(cwd, { recursive: true });
const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC']) {
  if (process.env[key]) env[key] = process.env[key];
}
env.CODEX_HOME = codexHome;
// With --no-env-key the engine must obtain the token some other way (for example the provider's
// `auth.command`), so no placeholder key is injected into the environment.
const injectEnvKey = !process.argv.includes('--no-env-key');
if (injectEnvKey) {
  env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'invalid-probe-key';
}
console.log(
  injectEnvKey
    ? `key source: ${process.env.DEEPSEEK_API_KEY ? 'environment' : 'invalid probe placeholder'}`
    : 'key source: none injected (expecting provider auth.command)',
);

const child = spawn(exe, ['app-server'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
const events = [];
let nextId = 0;
child.on('exit', (code) => { for (const p of pending.values()) p.reject(Error(`app-server exited ${code}`)); });
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method) {
    events.push(m);
    if (m.id != null) child.stdin.write(JSON.stringify({ id: m.id, error: { code: -32601, message: 'unexpected server request' } }) + '\n');
  }
});
const rpc = (method, params) => {
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
  });
};

try {
  await rpc('initialize', { clientInfo: { name: 'deepseek_live_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

  const thread = await rpc('thread/start', {
    cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true, model: 'deepseek-flash',
  });
  console.log(`thread provider=${thread.modelProvider} model=${thread.model}`);

  await rpc('turn/start', { threadId: thread.thread.id, input: [{ type: 'text', text: 'ping', text_elements: [] }] });
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (events.some((e) => e.method === 'turn/completed')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const completed = events.find((e) => e.method === 'turn/completed');
  const turn = completed?.params?.turn;
  console.log(`turn status=${turn?.status}`);
  if (turn?.error) console.log(`turn error: ${JSON.stringify(turn.error).slice(0, 600)}`);
  const items = events.filter((e) => e.method === 'item/started' || e.method === 'item/completed');
  for (const item of items.slice(-4)) {
    const text = JSON.stringify(item.params).slice(0, 500);
    if (/error|401|404|Missing|Unsupported|not found/i.test(text)) console.log(`item: ${text}`);
  }
  const errText = JSON.stringify(events.filter((e) => /error/i.test(JSON.stringify(e.method)))).slice(0, 800);
  if (errText && errText !== '[]') console.log(`error events: ${errText}`);
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
