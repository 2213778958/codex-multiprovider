// Local forwarding proxy for a Responses-style provider.
//
// The engine talks plain HTTP to this proxy; the proxy forwards to the real provider over TLS and
// rewrites item types the provider does not implement (`agent_message` -> a plain user `message`).
//
// Robustness contract:
//   * The rewrite can never make a request worse than no proxy: any parse or transform failure
//     forwards the original bytes untouched.
//   * Logging is best effort; a logging failure never fails a request.
//   * GET /__proxy/health answers a marker so a launcher can tell "our proxy" from "something else".
//
// usage:
//   node deepseek-proxy.mjs [--port 8899] [--upstream https://api.deepseek.com]
//                           [--downgrade-agent-messages] [--log <file>] [--body-dir <dir>]
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const argValue = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const port = Number(argValue('--port', '8899'));
const upstream = new URL(argValue('--upstream', 'https://api.deepseek.com'));
const downgrade = args.includes('--downgrade-agent-messages');
const logPath = argValue('--log', null) ? path.resolve(argValue('--log')) : null;
// Request bodies are only written when --body-dir is passed: they contain conversation content.
const bodyDirArg = argValue('--body-dir', null);
const bodyDir = bodyDirArg ? path.resolve(bodyDirArg) : null;
const HEALTH_MARKER = 'codex-multiprovider-proxy';

if (logPath) { try { fs.mkdirSync(path.dirname(logPath), { recursive: true }); } catch { /* best effort */ } }
if (bodyDir) { try { fs.mkdirSync(bodyDir, { recursive: true }); } catch { /* best effort */ } }

function log(entry) {
  if (!logPath) return;
  try { fs.appendFileSync(logPath, JSON.stringify(entry) + '\n'); } catch { /* never fail a request */ }
}

const AGENT_TEXT_KEYS = ['text', 'message', 'payload'];

// Heuristic: a long single token with no whitespace is treated as an opaque/encrypted payload
// rather than task text. Forwarding that as the task would feed the model garbage, which is worse
// than leaving the item untouched, so such items are not rewritten at all.
function looksLikeOpaquePayload(value) {
  return value.length > 64 && !/\s/.test(value) && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

// Returns the task text, or null when nothing usable could be extracted.
function agentMessageText(item) {
  const parts = [];
  const content = item.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') { parts.push(part); continue; }
      if (!part || typeof part !== 'object') continue;
      // The engine carries the inter-agent payload in an `encrypted_content` part. Today that value
      // is plaintext; if a future engine encrypts it, the guard below keeps us from forwarding it.
      if (typeof part.encrypted_content === 'string') {
        if (looksLikeOpaquePayload(part.encrypted_content)) return null;
        parts.push(part.encrypted_content);
        continue;
      }
      const value = AGENT_TEXT_KEYS.map((key) => part[key]).find((v) => typeof v === 'string' && v.length > 0);
      if (value) parts.push(value);
    }
  } else if (typeof content === 'string') {
    parts.push(content);
  }
  if (parts.length === 0) {
    for (const key of [...AGENT_TEXT_KEYS, 'encrypted_content']) {
      if (typeof item[key] === 'string') {
        if (looksLikeOpaquePayload(item[key])) return null;
        parts.push(item[key]);
      }
    }
  }
  if (parts.length === 0) return null;
  const sender = item.sender ?? item.author ?? item.from;
  return `${sender ? `[agent message from ${sender}]` : '[agent message]'}\n${parts.join('\n')}`;
}

function downgradeAgentMessages(body) {
  if (!Array.isArray(body.input)) return { body, converted: 0, skipped: 0 };
  let converted = 0;
  let skipped = 0;
  body.input = body.input.map((item) => {
    if (!item || typeof item !== 'object' || item.type !== 'agent_message') return item;
    const text = agentMessageText(item);
    // Leave anything we cannot read verbatim untouched: an unreadable item stays unreadable, but we
    // never inject ciphertext or JSON as if it were the task.
    if (text === null) { skipped += 1; return item; }
    converted += 1;
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
  });
  return { body, converted, skipped };
}

let requestIndex = 0;
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__proxy/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxy: HEALTH_MARKER, pid: process.pid, downgrade, upstream: upstream.origin }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    requestIndex += 1;
    const id = String(requestIndex).padStart(4, '0');
    let outgoing = raw;
    const summary = { id, path: req.url, bytes: raw.length, inputTypes: [] };

    // Transform defensively: on any failure fall back to the untouched request body.
    try {
      if (raw.length > 0 && (req.headers['content-type'] || '').includes('json')) {
        const body = JSON.parse(raw.toString('utf8'));
        if (Array.isArray(body.input)) {
          summary.inputTypes = [...new Set(body.input.map((item) => (item && item.type) || 'unknown'))];
        } else {
          summary.inputTypes = [typeof body.input === 'string' ? '<string input>' : '<none>'];
        }
        summary.model = body.model;
        summary.stream = body.stream;
        if (downgrade) {
          const result = downgradeAgentMessages(body);
          summary.downgradedAgentMessages = result.converted;
          if (result.skipped > 0) summary.unreadableAgentMessages = result.skipped;
          outgoing = Buffer.from(JSON.stringify(result.body), 'utf8');
        }
        if (bodyDir) {
          try { fs.writeFileSync(path.join(bodyDir, `${id}-request.json`), JSON.stringify(body, null, 2)); } catch { /* best effort */ }
        }
      }
    } catch (error) {
      summary.transformError = String(error.message);
      outgoing = raw;
    }
    log(summary);

    const headers = { ...req.headers };
    delete headers.host;
    headers.host = upstream.host;
    headers['content-length'] = Buffer.byteLength(outgoing);

    let upstreamRequest;
    try {
      upstreamRequest = https.request(
        {
          protocol: upstream.protocol,
          hostname: upstream.hostname,
          port: upstream.port || 443,
          path: req.url,
          method: req.method,
          headers,
        },
        (upstreamResponse) => {
          res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
          upstreamResponse.pipe(res);
        },
      );
    } catch (error) {
      log({ id, upstreamSetupError: String(error.message) });
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `proxy could not reach ${upstream.origin}: ${error.message}` } }));
      return;
    }
    upstreamRequest.on('error', (error) => {
      log({ id, upstreamError: String(error.message) });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `proxy upstream error: ${error.message}` } }));
    });
    upstreamRequest.end(outgoing);
  });
});

// Long model turns stream for minutes; do not let the default request timeout cut them off.
server.requestTimeout = 0;
server.headersTimeout = 120000;
server.keepAliveTimeout = 300000;

// A stray rejection must not take the proxy down mid-conversation.
process.on('uncaughtException', (error) => { log({ uncaughtException: String(error && error.message) }); });
process.on('unhandledRejection', (error) => { log({ unhandledRejection: String(error && error.message) }); });

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`port ${port} is already in use; another proxy may be running`);
  } else {
    console.error(`proxy server error: ${error.message}`);
  }
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`proxy listening on http://127.0.0.1:${port} -> ${upstream.origin}`);
  console.log(`agent_message downgrade: ${downgrade ? 'ON' : 'off'}`);
  if (logPath) console.log(`log: ${logPath}`);
});
