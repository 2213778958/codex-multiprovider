// Tests for the provider-compatibility rewrites and for the proxy wiring that applies them.
//
//   node --test multiprovider/tools/proxy-transforms.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { applyProviderRewrites } from './proxy-transforms.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const proxyScript = path.join(here, 'deepseek-proxy.mjs');

const delegation = '<codex_delegation>\n  <source_thread_id>01a09f4c</source_thread_id>\n  <input>pong</input>\n</codex_delegation>';

test('a function_call_output without a call_id becomes the user message it really is', () => {
  const carried = { type: 'function_call_output', call_id: 'call_1', output: 'tool result' };
  const dangling = {
    type: 'function_call_output',
    id: 'fco_01a0a394',
    name: 'create_thread',
    namespace: 'codex_app',
    output: delegation,
  };
  const body = {
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }, carried, dangling],
  };

  const summary = applyProviderRewrites(body, { agentMessages: true });

  assert.equal(summary.repairedCallOutputs, 1);
  assert.equal(summary.downgradedAgentMessages, 0);
  assert.deepEqual(body.input[1], carried);
  assert.deepEqual(body.input[2], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: delegation }],
  });
});

test('a tool result wrapped in a payload object is still read verbatim', () => {
  const body = {
    input: [
      { type: 'function_call_output', output: { body: delegation, success: null } },
      { type: 'function_call_output', output: { body: [{ type: 'output_text', text: delegation }] } },
    ],
  };

  const summary = applyProviderRewrites(body, { agentMessages: true });

  assert.equal(summary.repairedCallOutputs, 2);
  assert.equal(body.input[0].content[0].text, delegation);
  assert.equal(body.input[1].content[0].text, delegation);
});

test('an empty or opaque tool result is left untouched', () => {
  const empty = { type: 'function_call_output', output: { body: '   ' } };
  const opaque = { type: 'function_call_output', output: { body: 'A'.repeat(200) } };
  const body = { input: [empty, opaque] };

  const summary = applyProviderRewrites(body, { agentMessages: true });

  assert.equal(summary.repairedCallOutputs, 0);
  assert.equal(summary.unreadableItems, 2);
  assert.deepEqual(body.input, [empty, opaque]);
});

test('agent_message items still downgrade', () => {
  const body = {
    input: [
      {
        type: 'agent_message',
        author: '/root',
        content: [
          { type: 'input_text', text: 'Message Type: NEW_TASK' },
          { type: 'encrypted_content', encrypted_content: 'do the thing' },
        ],
      },
    ],
  };

  const summary = applyProviderRewrites(body, { agentMessages: true });

  assert.equal(summary.downgradedAgentMessages, 1);
  assert.deepEqual(body.input[0], {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: '[agent message from /root]\nMessage Type: NEW_TASK\ndo the thing' }],
  });
});

test('the proxy rewrites the request on its way to the provider', async () => {
  let received = null;
  const upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const upstreamPort = await listen(upstream);
  const proxyPort = await freePort();
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-proxy-test-'));
  const logPath = path.join(logDir, 'proxy-log.jsonl');
  const proxy = spawn(
    process.execPath,
    [
      proxyScript,
      '--port',
      String(proxyPort),
      '--upstream',
      `http://127.0.0.1:${upstreamPort}`,
      '--downgrade-agent-messages',
      '--log',
      logPath,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  try {
    await waitForHealth(proxyPort);
    const response = await fetch(`http://127.0.0.1:${proxyPort}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash',
        stream: false,
        input: [{ type: 'function_call_output', id: 'fco_test', name: 'create_thread', output: delegation }],
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(received.input, [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: delegation }] },
    ]);
    const logged = fs.readFileSync(logPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(logged.at(-1).repairedCallOutputs, 1);
  } finally {
    proxy.kill();
    upstream.close();
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(port) {
  const deadline = Date.now() + 10000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/__proxy/health`);
      const health = await response.json();
      if (health.ok === true) return;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`proxy on port ${port} never became healthy`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
