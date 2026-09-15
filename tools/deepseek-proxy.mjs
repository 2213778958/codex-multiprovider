// Local forwarding proxy for a Responses-style provider.
//
// The engine talks plain HTTP to this proxy; the proxy forwards to the real provider over TLS and
// rewrites item types the provider does not implement (`agent_message` -> a plain user `message`,
// `function_call_output` without a `call_id` -> the user message it really is).
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
import { applyProviderRewrites } from './proxy-transforms.mjs';

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
        const rewrites = applyProviderRewrites(body, { agentMessages: downgrade });
        if (downgrade) summary.downgradedAgentMessages = rewrites.downgradedAgentMessages;
        if (rewrites.repairedCallOutputs > 0) summary.repairedCallOutputs = rewrites.repairedCallOutputs;
        if (rewrites.unreadableItems > 0) summary.unreadableItems = rewrites.unreadableItems;
        // Re-serialize only when a rewrite changed something; otherwise the body stays byte-identical.
        if (rewrites.downgradedAgentMessages + rewrites.repairedCallOutputs > 0) {
          outgoing = Buffer.from(JSON.stringify(body), 'utf8');
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
      // A loopback mock or another local provider speaks plain HTTP; TLS is only for real providers.
      const transport = upstream.protocol === 'http:' ? http : https;
      upstreamRequest = transport.request(
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
