// Two-turn probe: does a finished child keep holding a concurrency slot?
// turn 1: spawn one child, wait for it, list agents.
// turn 2: spawn four more children and list agents again.
// The engine reports agent states inside collab tool items (`agentsStates`), so we read those
// instead of trusting the model's prose.
//
// usage: node subagent-slot-probe.mjs <codexExe> <codexHome> <providerBaseUrl>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [exe, codexHome, providerBaseUrl] = process.argv.slice(2);
if (!exe || !codexHome || !providerBaseUrl) {
  throw Error('usage: node subagent-slot-probe.mjs <codexExe> <codexHome> <providerBaseUrl>');
}

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-probe-'));
const catalog = path.join(codexHome, 'merged-models.json');
// --keep-config uses the CODEX_HOME's existing config.toml instead of writing a throwaway one, so a
// real configuration can be exercised end to end.
const keepConfig = process.argv.includes('--keep-config');
if (!keepConfig) {
  fs.writeFileSync(
  path.join(codexHome, 'config.toml'),
  [
    'web_search = "disabled"',
    `model_catalog_json = ${JSON.stringify(catalog)}`,
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '[features]',
    'multi_agent = true',
    'multi_agent_v2 = true',
    '[model_providers.deepseek]',
    'name = "DeepSeek"',
    `base_url = ${JSON.stringify(providerBaseUrl)}`,
    'env_key = "DEEPSEEK_API_KEY"',
    'wire_api = "responses"',
    'requires_openai_auth = false',
    '[model_provider_routes]',
    '"deepseek-flash" = "deepseek"',
    '',
  ].join('\n'),
  );
}

const TURN1 = [
  'Do exactly this, in order, and nothing else:',
  "1. Call spawn_agent once: task_name 'c1', fork_turns 'none', message 'Reply with exactly DONE_C1'.",
  '2. Call wait_agent for it.',
  '3. Call list_agents.',
  "4. Reply with exactly: TURN1_DONE plus the raw list_agents JSON.",
].join('\n');

const TURN2 = [
  'Do exactly this, in order, and nothing else:',
  "1. Call spawn_agent four times (sequential calls are fine): task_name 'p1'..'p4', fork_turns 'none', message 'Reply with exactly OK_<task_name>'.",
  '2. Call list_agents.',
  '3. Reply with exactly: TURN2_DONE plus the raw list_agents JSON, and for every spawn call report its exact result text.',
].join('\n');

// Optional prompt override: --prompts <json file with {"turn1": "...", "turn2": "..."}>
const promptsIndex = process.argv.indexOf('--prompts');
const promptOverrides = promptsIndex === -1 ? null : JSON.parse(fs.readFileSync(process.argv[promptsIndex + 1], 'utf8'));
const turn1Prompt = promptOverrides?.turn1 ?? TURN1;
const turn2Prompt = promptOverrides?.turn2 ?? TURN2;

const env = {};
for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'COMSPEC', 'DEEPSEEK_API_KEY']) {
  if (process.env[key]) env[key] = process.env[key];
}
env.CODEX_HOME = codexHome;
// A throwaway config uses env_key, so it needs the key in the environment. --keep-config may use a
// provider whose token comes from auth.command instead.
if (!keepConfig && !env.DEEPSEEK_API_KEY) throw Error('DEEPSEEK_API_KEY must be set in the environment');

const child = spawn(exe, ['app-server'], { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
const pending = new Map();
const notifications = [];
let stderr = '';
let nextId = 0;
child.stderr.on('data', (b) => { stderr = (stderr + b).slice(-2000); });
child.on('exit', (code) => { for (const p of pending.values()) p.reject(Error(`app-server exited ${code}`)); });
readline.createInterface({ input: child.stdout }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id != null && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result);
  } else if (m.method) {
    notifications.push(m);
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

function collabSummary(label) {
  const items = notifications.filter((n) => {
    const item = n.params?.item;
    return item && item.type === 'collabAgentToolCall';
  });
  console.log(`\n=== ${label}: ${items.length} collab tool items ===`);
  for (const notification of items) {
    const item = notification.params.item;
    const states = Object.entries(item.agentsStates ?? {}).map(([thread, state]) => `${thread.slice(-6)}=${state.status ?? JSON.stringify(state)}`);
    console.log(`  ${String(item.tool).padEnd(16)} ${String(item.status).padEnd(10)} ${states.join(' ') || '(no states)'}`);
  }
}

async function runTurn(threadId, text, label, timeoutMs) {
  const before = notifications.length;
  await rpc('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }] });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const done = notifications.slice(before).find((n) => n.method === 'turn/completed' && n.params.threadId === threadId);
    if (done) {
      const turn = done.params.turn;
      console.log(`\n[${label}] turn status=${turn?.status}${turn?.error ? ` error=${JSON.stringify(turn.error).slice(0, 200)}` : ''}`);
      return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log(`\n[${label}] TIMEOUT waiting for turn completion`);
}

try {
  await rpc('initialize', { clientInfo: { name: 'slot_probe', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n');

  const thread = await rpc('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', model: 'deepseek-flash' });
  console.log(`parent thread provider=${thread.modelProvider} model=${thread.model} id=${thread.thread.id.slice(-6)}`);

  await runTurn(thread.thread.id, turn1Prompt, 'turn1', 240000);
  collabSummary('after turn1');

  await runTurn(thread.thread.id, turn2Prompt, 'turn2', 300000);
  collabSummary('after turn2');

  const limitHits = notifications.filter((n) => JSON.stringify(n.params ?? {}).includes('agent thread limit'));
  console.log(`\nmentions of "agent thread limit": ${limitHits.length}`);
  for (const hit of limitHits.slice(0, 3)) {
    console.log(`  limit text: ${JSON.stringify(hit.params).slice(0, 260)}`);
  }
  const errorEvents = notifications.filter((n) => n.method === 'error');
  console.log(`error notifications: ${errorEvents.length}`);
  for (const event of errorEvents.slice(0, 3)) {
    console.log(`  error: ${JSON.stringify(event.params).slice(0, 220)}`);
  }
  const startedThreads = notifications.filter((n) => n.method === 'thread/started').map((n) => n.params.thread.id.slice(-6));
  console.log(`threads started: ${startedThreads.length} -> ${startedThreads.join(', ')}`);
  const itemTypes = [...new Set(notifications.filter((n) => n.method === 'item/completed').map((n) => n.params?.item?.type))];
  console.log(`item types seen: ${itemTypes.join(', ')}`);
  const texts = notifications
    .filter((n) => n.method === 'item/completed' && n.params?.item?.type === 'agentMessage')
    .map((n) => n.params.item.text);
  for (const text of texts.slice(-2)) console.log(`--- model says: ${text.slice(0, 500)}`);
} catch (e) {
  console.log(`FAIL: ${e.message}`);
  if (stderr) console.log(`stderr tail: ${stderr.slice(-500)}`);
  process.exitCode = 1;
} finally {
  child.stdin.end();
  child.kill();
}
