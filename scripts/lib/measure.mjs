/**
 * Context measurement and configuration for the context-guard skill
 * (WorkBuddy port).
 *
 * Measurement strategy, in order of trust:
 *  1. Provider-reported usage anchor — WorkBuddy stamps every model request
 *     with `providerData.usage` on the `function_call` / `message` event
 *     produced by that request. `usage.totalTokens` is the full prompt of that
 *     request (input + output). That IS the context occupancy at that step.
 *  2. Everything appended to the model surface after the anchor, priced with a
 *     local heuristic, is added as a delta, so a check made mid-turn (after new
 *     tool results landed) still reports current pressure.
 *  3. With no anchor at all (a brand-new session) the whole visible surface is
 *     priced heuristically and flagged approximate.
 *
 * Mapping from the DSH event vocabulary this skill was written against:
 *   session                -> (synthesised from the first `session-meta`)
 *   assistant/message      -> `message` with role=assistant, or any event
 *                             carrying providerData.usage
 *   user/message           -> `message` with role=user
 *   tool/result            -> `function_call_result`
 *   tool call              -> `function_call`
 *   turn/start, step/end   -> not emitted; turns/steps are derived instead
 *   request/context        -> absent; the window comes from config fallback
 *
 * The heuristic is 4 characters per token for non-CJK plus 0.8 per CJK code
 * point with a small structural overhead per message. It is approximate by
 * design — it is only ever used for deltas and for the anchorless fallback,
 * never to contradict provider usage.
 */

import fs from 'node:fs';
import path from 'node:path';
import { findSessionLog, readSessionHeader, readSessionLog, resolveDshHome, tidyPath } from './session-log.mjs';

export const SURFACE_TYPES = new Set([
  'message',              // role=user / role=assistant
  'function_call',        // tool invocation + its usage anchor
  'function_call_result', // tool output
]);

export const DEFAULT_CONFIG = {
  contextWindow: null,
  warnAt: 0.7,
  criticalAt: 0.9,
  // WorkBuddy logs carry no window figure, so this fallback IS the window.
  // Measured: a `deepseek-v4.1-flash` session kept working at 199k tokens, so
  // 128k (the DSH default) would cry critical far too early. Override per
  // workspace or with --window if your model routes differ.
  windowFallback: 200000,
  handoffDir: '.workbuddy/handoff',
  announceOnce: true,
  writeState: true,
};

/** Approximate token price of a value (string or JSON-serializable). */
export function estimateTokens(value) {
  const text = typeof value === 'string' ? value : safeStringify(value);
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.codePointAt(0) >= 0x2e80) cjk++;
    else other++;
  }
  return Math.ceil(other / 4 + cjk * 0.8) + 8;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

/** Provider usage → context occupancy of that request, or undefined. */
export function usageTotal(usage) {
  if (!usage || typeof usage !== 'object') return undefined;
  if (Number.isFinite(usage.totalTokens) && usage.totalTokens > 0) return usage.totalTokens;
  const parts = ['inputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'outputTokens']
    .map((key) => (Number.isFinite(usage[key]) ? usage[key] : 0))
    .reduce((a, b) => a + b, 0);
  return parts > 0 ? parts : undefined;
}

/**
 * WorkBuddy stamps `providerData.usage` on the event produced by a request.
 * Both `function_call` and `message` events carry it; we accept either.
 */
export function providerUsage(event) {
  return usageTotal(event?.providerData?.usage);
}

/** The model-visible message payload carried by one surface event. */
export function surfacePayload(event) {
  if (event.type === 'message') {
    return { role: event.role ?? 'user', content: event.content };
  }
  if (event.type === 'function_call') {
    return { role: 'assistant', content: [{ type: 'tool_use', name: event.name, input: event.arguments }] };
  }
  if (event.type === 'function_call_result') {
    return { role: 'tool', content: [{ type: 'tool_result', content: event.output }] };
  }
  if (event.data?.message) return event.data.message;
  return { role: event.data?.role ?? 'user', content: event.data?.content };
}

/**
 * Visible text of a message payload.
 *
 * Deliberately collects ONLY `text` blocks: reasoning blocks are the model's
 * private chain-of-thought and tool-call arguments are already summarized
 * elsewhere, so neither belongs in a handoff document.
 */
export function messageText(message) {
  const parts = [];
  // WorkBuddy tags its blocks `input_text` (human/prompt channel) and
  // `output_text` (model reply); DSH used a bare `text`. Accept all three so
  // callers do not have to care which harness wrote the log.
  const TEXT_BLOCK_TYPES = new Set([undefined, 'text', 'input_text', 'output_text']);
  const isTextBlock = (value) => typeof value.text === 'string' && TEXT_BLOCK_TYPES.has(value.type);
  const walk = (value) => {
    if (value == null) return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value !== 'object') return;
    if (isTextBlock(value)) parts.push(value.text);
    if (typeof value.content === 'string') walk({ type: 'text', text: value.content });
    else if (Array.isArray(value.content)) walk(value.content);
  };
  walk(message?.content);
  return parts.join('\n').trim();
}

/**
 * True when a `message` event carries something a human actually typed.
 *
 * WorkBuddy logs every harness injection as a `role: "user"` message too —
 * turn context (`<system-reminder>`), background-task notices
 * (`<task-notification>`), and the compaction brief
 * (`<conversation_history_summary>`). Counting those as turns inflates a
 * 2-turn session into a 23-turn one, so filter them out here.
 */
export function isHumanMessage(event) {
  if (event?.role !== 'user') return false;
  const blocks = Array.isArray(event.content) ? event.content : [];
  for (const block of blocks) {
    if (typeof block?.text !== 'string') continue;
    const head = block.text.trimStart();
    if (!INJECTED_WRAPPERS.test(head)) return true;
  }
  return false;
}

const INJECTED_WRAPPERS = /^<(system-reminder|task-notification|conversation_history_summary)\b/;

/**
 * Fold a session's durable log into measurement facts.
 * @param {object[]} events session events in file order.
 */
export function analyzeEvents(events) {
  let title = null;
  let model = null;
  let turns = 0;
  let steps = 0;
  let anchor = null;
  let anchorIndex = -1;
  let sessionId = null;
  let cwd = null;
  const surface = [];

  events.forEach((event, index) => {
    // Identity + metadata ride on every event in WorkBuddy.
    sessionId = sessionId ?? event.sessionId ?? null;
    cwd = cwd ?? tidyPath(event.cwd) ?? null;
    model = model ?? event.providerData?.model ?? null;

    switch (event.type) {
      case 'ai-title':
        if (typeof event.aiTitle === 'string' && event.aiTitle.trim()) title = event.aiTitle;
        break;
      case 'message':
        if (isHumanMessage(event)) turns += 1;
        break;
      default:
        break;
    }

    if (!SURFACE_TYPES.has(event.type)) return;

    // The usage anchor: any surface event whose providerData carries usage.
    // WorkBuddy emits it on the request-producing event, so the latest wins.
    const total = providerUsage(event);
    if (total !== undefined) {
      anchor = { seq: index, tokens: total, usage: event.providerData.usage };
      anchorIndex = surface.length; // how many surface nodes preceded it
    }
    steps += 1;
    surface.push(event);
  });

  const priced = surface.map((event, i) => ({
    seq: i,
    type: event.type,
    tokens: estimateTokens(surfacePayload(event)),
  }));
  const surfaceTokens = priced.reduce((sum, node) => sum + node.tokens, 0);
  // Everything appended after the anchor is the mid-turn delta.
  const afterAnchor = anchor ? priced.filter((node) => node.seq > anchorIndex) : [];
  const deltaTokens = afterAnchor.reduce((sum, node) => sum + node.tokens, 0);

  const anchorUsable = Boolean(anchor);
  const pressureTokens = anchorUsable ? anchor.tokens + deltaTokens : surfaceTokens;

  return {
    header: sessionId ? { type: 'session', id: sessionId, cwd } : null,
    sessionId,
    cwd,
    title,
    provider: null,
    model,
    contextWindow: null, // WorkBuddy logs carry no window; config supplies it
    turns,
    steps,
    anchorSeq: anchor?.seq ?? null,
    anchorTokens: anchor?.tokens ?? null,
    deltaTokens,
    surfaceTokens,
    headerTokens: 0,
    headerSeq: -1,
    surfaceNodes: surface.length,
    replacements: [],
    anchorStale: false,
    method: anchorUsable ? 'usage-anchor' : 'heuristic-surface',
    approximate: !anchorUsable,
    pressureTokens,
    nodes: priced.slice(-25),
  };
}

/** Read one config file; missing or malformed files contribute nothing. */
export function readConfigFile(file) {
  if (!file) return {};
  try {
    const text = fs.readFileSync(file, 'utf8');
    // PowerShell's `Out-File -Encoding utf8` may prepend a BOM; tolerate it.
    const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Parse a threshold: `0.7` / `70%` is a ratio, anything above 1 is absolute tokens. */
export function parseThreshold(value) {
  if (value == null || value === '') return undefined;
  if (typeof value === 'number') return value;
  const text = String(value).trim();
  if (text.endsWith('%')) {
    const ratio = Number(text.slice(0, -1)) / 100;
    return Number.isFinite(ratio) ? ratio : undefined;
  }
  const numeric = Number(text);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function firstDefined(...values) {
  for (const value of values) if (value !== undefined && value !== null) return value;
  return undefined;
}

/**
 * Merge configuration: skill defaults < skill config.json < workspace
 * `.workbuddy/context-guard.json` < environment < CLI flags.
 *
 * Env vars accept both the WB_* names (this port) and the legacy DSH_CTX_*
 * names, so an existing configuration keeps working after the port.
 */
export function loadConfig({ skillDir, cwd, env = process.env, cli = {} } = {}) {
  const skillFile = skillDir ? path.join(skillDir, 'config.json') : null;
  const workspaceFile = cwd ? path.join(cwd, '.workbuddy', 'context-guard.json') : null;
  const merged = {
    ...DEFAULT_CONFIG,
    ...readConfigFile(skillFile),
    ...readConfigFile(workspaceFile),
  };
  const sources = { skillFile, workspaceFile };
  const pick = (...names) => names.map((n) => env[n]).find((v) => v !== undefined);
  const envConfig = {
    contextWindow: parseThreshold(pick('WB_CTX_WINDOW', 'DSH_CTX_WINDOW')),
    windowFallback: parseThreshold(pick('WB_CTX_WINDOW_FALLBACK', 'DSH_CTX_WINDOW_FALLBACK')),
    warnAt: parseThreshold(pick('WB_CTX_WARN', 'DSH_CTX_WARN')),
    criticalAt: parseThreshold(pick('WB_CTX_CRITICAL', 'DSH_CTX_CRITICAL')),
    handoffDir: pick('WB_CTX_HANDOFF_DIR', 'DSH_CTX_HANDOFF_DIR'),
    announceOnce:
      pick('WB_CTX_ANNOUNCE_ONCE', 'DSH_CTX_ANNOUNCE_ONCE') === undefined
        ? undefined
        : pick('WB_CTX_ANNOUNCE_ONCE', 'DSH_CTX_ANNOUNCE_ONCE') !== '0',
    writeState: pick('WB_CTX_NO_STATE', 'DSH_CTX_NO_STATE') === '1' ? false : undefined,
  };
  const cliConfig = {
    contextWindow: parseThreshold(cli.window),
    windowFallback: parseThreshold(cli.windowFallback),
    warnAt: parseThreshold(cli.warn),
    criticalAt: parseThreshold(cli.critical),
    handoffDir: cli.handoffDir,
    writeState: cli.noState ? false : undefined,
  };
  for (const key of Object.keys(DEFAULT_CONFIG)) {
    const value = firstDefined(cliConfig[key], envConfig[key]);
    if (value !== undefined) merged[key] = value;
  }
  merged.warnAt = normalizeThreshold(merged.warnAt, 0.7);
  merged.criticalAt = normalizeThreshold(merged.criticalAt, 0.9);
  return { config: merged, sources };
}

function normalizeThreshold(value, fallback) {
  const parsed = parseThreshold(value);
  return parsed === undefined || parsed <= 0 ? fallback : parsed;
}

/** Turn a threshold (ratio or absolute tokens) into tokens for a window size. */
export function thresholdTokens(threshold, window) {
  return threshold <= 1 ? Math.round(threshold * window) : Math.round(threshold);
}

/**
 * Full measurement: locate the log, fold it, apply thresholds and report.
 * @returns measurement object consumed by both CLIs.
 */
export function measureContext(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const dshHome = resolveDshHome(options.dshHome);
  const located = options.logPath
    ? (() => {
        const header = readSessionHeader(options.logPath);
        return {
          logPath: options.logPath,
          sessionId: header?.id ?? options.session ?? null,
          cwd: header?.cwd ?? cwd,
          header,
          via: 'explicit',
        };
      })()
    : findSessionLog({ sessionId: options.session, cwd, dshHome: options.dshHome });
  const { events, frames, bytes, tornStart } = readSessionLog(located.logPath);
  const analysis = analyzeEvents(events);
  const { config, sources } = loadConfig({ skillDir: options.skillDir, cwd, env: options.env, cli: options.cli ?? {} });

  const window = firstDefined(config.contextWindow, analysis.contextWindow, config.windowFallback);
  const windowSource = config.contextWindow
    ? 'config'
    : Number.isFinite(analysis.contextWindow)
      ? 'session(request/context)'
      : 'windowFallback';
  const warnTokens = thresholdTokens(config.warnAt, window);
  const criticalTokens = thresholdTokens(config.criticalAt, window);
  const pressure = Math.max(0, Math.round(analysis.pressureTokens));
  const ratio = window > 0 ? pressure / window : 0;
  const level = pressure >= criticalTokens ? 'critical' : pressure >= warnTokens ? 'warn' : 'ok';
  // Growth rate: the surface reached `pressure` over `steps` model requests, so
  // the mean increment per request is the honest extrapolation basis.
  const tokensPerStep = analysis.steps > 0 ? Math.round(pressure / analysis.steps) : null;
  const stepsPerTurn = analysis.steps > 0 && analysis.turns > 0 ? analysis.steps / analysis.turns : null;
  const remainingToCritical = Math.max(0, criticalTokens - pressure);
  const stepsToCritical = tokensPerStep ? Math.ceil(remainingToCritical / tokensPerStep) : null;
  const turnsToCritical =
    stepsToCritical !== null && stepsToCritical > 0 && stepsPerTurn ? Math.max(1, Math.ceil(stepsToCritical / stepsPerTurn)) : stepsToCritical;

  return {
    ...analysis,
    logPath: located.logPath,
    logVia: located.via,
    logBytes: bytes,
    logFrames: frames,
    logTornTail: tornStart !== undefined,
    dshHome,
    window,
    windowSource,
    warnAt: config.warnAt,
    criticalAt: config.criticalAt,
    warnTokens,
    criticalTokens,
    pressureTokens: pressure,
    ratio,
    percent: Number((ratio * 100).toFixed(1)),
    remainingTokens: Math.max(0, window - pressure),
    tokensPerStep,
    stepsPerTurn,
    stepsToCritical,
    turnsToCritical,
    level,
    config,
    configSources: sources,
  };
}
