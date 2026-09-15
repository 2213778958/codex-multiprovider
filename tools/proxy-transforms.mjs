// Provider-compatibility rewrites for the local forwarding proxy.
//
// The engine emits item types a second provider may not implement. Each rewrite maps one of those
// items onto something a plain Responses implementation accepts. Every rewrite is conservative:
// anything this module cannot read verbatim is left untouched, so a request is never made worse
// than it would have been without the proxy.

const AGENT_TEXT_KEYS = ['text', 'message', 'payload'];

// Heuristic: a long single token with no whitespace is treated as an opaque/encrypted payload
// rather than task text. Forwarding that as the task would feed the model garbage, which is worse
// than leaving the item untouched, so such items are not rewritten at all.
export function looksLikeOpaquePayload(value) {
  return value.length > 64 && !/\s/.test(value) && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

// Returns the task text of an `agent_message` item, or null when nothing usable could be read.
export function agentMessageText(item) {
  const parts = [];
  const content = item.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      if (!part || typeof part !== 'object') continue;
      // The engine carries the inter-agent payload in an `encrypted_content` part. Today that value
      // is plaintext; if a future engine encrypts it, the guard below keeps us from forwarding it.
      if (typeof part.encrypted_content === 'string') {
        if (looksLikeOpaquePayload(part.encrypted_content)) return null;
        parts.push(part.encrypted_content);
        continue;
      }
      const value = AGENT_TEXT_KEYS.map((key) => part[key]).find(
        (candidate) => typeof candidate === 'string' && candidate.length > 0,
      );
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

// A tool result travels as text, as a list of content items, or wrapped (`{ body: ... }`); read all
// of those shapes so a rewrite never depends on which one the current engine build emits.
function textFromValue(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts = value.map(textFromValue).filter((part) => typeof part === 'string' && part.length > 0);
    return parts.length > 0 ? parts.join('\n') : null;
  }
  if (value && typeof value === 'object') {
    for (const key of ['body', 'text', 'output', 'content']) {
      const text = textFromValue(value[key]);
      if (text !== null) return text;
    }
    let longest = null;
    for (const nested of Object.values(value)) {
      const text = textFromValue(nested);
      if (text !== null && (longest === null || text.length > longest.length)) longest = text;
    }
    return longest;
  }
  return null;
}

// Returns the result text of a `function_call_output` item, or null when nothing usable was found.
export function functionCallOutputText(item) {
  const text = textFromValue(item.output);
  return text !== null && text.trim().length > 0 ? text : null;
}

// `agent_message` -> a plain user message. The engine sends every inter-agent payload, including
// the first task of a spawned subagent, in that shape.
export function downgradeAgentMessages(body) {
  if (!Array.isArray(body.input)) return { body, converted: 0, skipped: 0 };
  let converted = 0;
  let skipped = 0;
  body.input = body.input.map((item) => {
    if (!item || typeof item !== 'object' || item.type !== 'agent_message') return item;
    const text = agentMessageText(item);
    // Leave anything we cannot read verbatim untouched: an unreadable item stays unreadable, but we
    // never inject ciphertext or JSON as if it were the task.
    if (text === null) {
      skipped += 1;
      return item;
    }
    converted += 1;
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
  });
  return { body, converted, skipped };
}

// `function_call_output` without a `call_id` -> a plain user message.
//
// Such an item cannot be matched to a function call by any provider. The desktop client injects the
// task of an agent-created thread that way when `create_thread` delegates work, and providers
// differ on whether they tolerate it: the ones that do not reject the whole request with
// "missing field `call_id`". The item is really a user message, so that is what it becomes.
export function repairCallOutputsMissingCallId(body) {
  if (!Array.isArray(body.input)) return { body, converted: 0, skipped: 0 };
  let converted = 0;
  let skipped = 0;
  body.input = body.input.map((item) => {
    if (!item || typeof item !== 'object' || item.type !== 'function_call_output') return item;
    const callId = item.call_id;
    if (typeof callId === 'string' && callId.trim().length > 0) return item;
    const text = functionCallOutputText(item);
    if (text === null || looksLikeOpaquePayload(text.trim())) {
      skipped += 1;
      return item;
    }
    converted += 1;
    return { type: 'message', role: 'user', content: [{ type: 'input_text', text }] };
  });
  return { body, converted, skipped };
}

// Applies every rewrite the proxy knows about and reports what changed.
export function applyProviderRewrites(body, { agentMessages }) {
  const summary = { downgradedAgentMessages: 0, repairedCallOutputs: 0, unreadableItems: 0 };
  if (agentMessages) {
    const result = downgradeAgentMessages(body);
    summary.downgradedAgentMessages = result.converted;
    summary.unreadableItems += result.skipped;
  }
  const repaired = repairCallOutputsMissingCallId(body);
  summary.repairedCallOutputs = repaired.converted;
  summary.unreadableItems += repaired.skipped;
  return summary;
}
