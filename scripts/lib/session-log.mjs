/**
 * WorkBuddy session-log reader — the WorkBuddy port of the DSH reader.
 *
 * Differences from DSH that this file absorbs:
 *   - No zstd: WorkBuddy appends plain JSONL to
 *     `~/.workbuddy/projects/<project-key>/<sessionId>.jsonl`.
 *     (DSH uses a multi-frame `session.v<N>.jsonl.zstd` container.)
 *   - The project key is a flattened `c-Users-foo-Bar` style name, not the
 *     `--c-...--` form DSH uses.
 *   - Session id lives inside every event (`.sessionId`), not only a header.
 *
 * Filesystem-only on purpose: it must keep working when the harness runs under
 * a sandbox that forbids child processes and named pipes.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * WorkBuddy project keys are the workspace path with separators and the drive
 * colon collapsed to `-`, and every character outside `[A-Za-z0-9._-]` (and
 * non-ASCII) kept verbatim. Observed shapes:
 *   C:\Users\alice\WorkBuddy\my-project
 *     -> c-Users-alice-WorkBuddy-my-project
 *   C:\Users\alice\WorkBuddy\生图模型
 *     -> c-Users-alice-WorkBuddy-生图模型   (non-ASCII kept as-is)
 * Note the lowercased drive letter, unlike DSH's `--C-...--`.
 */
export function projectKey(cwd) {
  if (!cwd) throw new Error('projectKey requires a cwd');
  let out = '';
  let separatorRun = false;
  for (const ch of String(cwd)) {
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) out += '-';
      separatorRun = true;
    } else {
      out += ch;
      separatorRun = false;
    }
  }
  // Flattened keys always start with the lowercased drive letter, e.g. `c-`.
  return out.replace(/^([A-Za-z])-/, (_m, drive) => `${drive.toLowerCase()}-`);
}

/** Decode a WorkBuddy JSONL log body (plain text — kept as a function so call
 *  sites read the same as the DSH version). */
export function decodeLogBuffer(buffer) {
  return { text: buffer.toString('utf8'), frames: 0, bytes: buffer.length, tornStart: undefined };
}

/** Parse JSONL text into events, skipping blank or malformed lines. */
export function parseEventLines(text) {
  const events = [];
  // Tolerate a UTF-8 BOM on hand-written or exported logs.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (const line of body.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object' && typeof value.type === 'string') events.push(value);
    } catch {
      /* a torn tail line is expected while the session is live */
    }
  }
  return events;
}

/**
 * Read and parse a session log.
 * @param {string} logPath path to a WorkBuddy `<sessionId>.jsonl`.
 */
export function readSessionLog(logPath) {
  const buffer = fs.readFileSync(logPath);
  const events = parseEventLines(buffer.toString('utf8'));
  return { events, frames: 0, bytes: buffer.length, tornStart: undefined };
}

/** Restore the conventional drive-letter case: WorkBuddy logs `c:\Users\...`. */
export function tidyPath(value) {
  if (typeof value !== 'string' || !value) return value;
  return value.replace(/^([a-z]):(?=[\\/])/, (_m, drive) => `${drive.toUpperCase()}:`);
}

/**
 * First-event identity, normalised to the shape callers expect.
 *
 * WorkBuddy has no dedicated `session` header event: the first line is a
 * `session-meta` carrying `sessionId`, and the `cwd` rides on later events.
 * We synthesise `{ id, cwd }` from whatever the first events give us so the
 * rest of the code (which only reads `.id` / `.cwd`) keeps working unchanged.
 */
export function readSessionHeader(logPath) {
  let events;
  try {
    events = parseEventLines(fs.readFileSync(logPath, 'utf8'));
  } catch {
    return null;
  }
  if (!events.length) return null;
  let id = null;
  let cwd = null;
  for (const event of events) {
    id = id ?? event.sessionId ?? null;
    cwd = cwd ?? tidyPath(event.cwd) ?? null;
    if (id && cwd) break;
  }
  return { type: 'session', id, cwd };
}

/** Resolve the WorkBuddy home directory. */
export function resolveDshHome(explicit) {
  if (explicit) return explicit;
  if (process.env.WORKBUDDY_HOME) return process.env.WORKBUDDY_HOME;
  if (process.env.DSH_HOME) return process.env.DSH_HOME; // honour the DSH var too
  return path.join(os.homedir(), '.workbuddy');
}

function listFiles(root, suffix) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function listDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name));
  } catch {
    return [];
  }
}

function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/** Every `*.jsonl` under a project dir, newest mtime first. */
function logsInProjectDir(projectDir) {
  return listFiles(projectDir, '.jsonl')
    .map((file) => ({ file, stamp: mtimeOf(file) }))
    .sort((a, b) => b.stamp - a.stamp);
}

/**
 * Find the session log for a session id / workspace.
 *
 * WorkBuddy layout is flat: `<projects>/<project-key>/<sessionId>.jsonl`, so
 * the exact path is usually enough. We still keep a scan fallback for a stale
 * project key (renamed/moved workspace).
 *
 * @returns {{logPath: string, sessionId: string, cwd: string|undefined, header: object|null, via: string}}
 */
export function findSessionLog({ sessionId, cwd, dshHome } = {}) {
  const root = path.join(resolveDshHome(dshHome), 'projects');
  const wanted = sessionId ?? process.env.WORKBUDDY_SESSION_ID ?? process.env.DSH_SESSION_ID;
  const workspace = cwd ?? process.cwd();

  const accept = (logPath, via) => {
    const header = readSessionHeader(logPath);
    if (wanted && header?.id && header.id !== wanted) return null;
    return { logPath, sessionId: header?.id ?? wanted, cwd: header?.cwd ?? workspace, header, via };
  };

  if (wanted) {
    const direct = path.join(root, projectKey(workspace), `${wanted}.jsonl`);
    if (fs.existsSync(direct)) {
      const hit = accept(direct, 'direct');
      if (hit) return hit;
    }
    for (const projectDir of listDirs(root)) {
      const candidate = path.join(projectDir, `${wanted}.jsonl`);
      if (fs.existsSync(candidate)) {
        const hit = accept(candidate, 'id-scan');
        if (hit) return hit;
      }
    }
    const error = new Error(
      `no WorkBuddy session log found for session id "${wanted}". Pass --log <path> or --session <id>, or set WORKBUDDY_SESSION_ID.`,
    );
    error.code = 'ENOLOG';
    throw error;
  }

  const projectDirs = cwd ? [path.join(root, projectKey(workspace))] : listDirs(root);
  let best;
  for (const projectDir of projectDirs) {
    for (const { file, stamp } of logsInProjectDir(projectDir)) {
      if (!best || stamp > best.stamp) best = { path: file, stamp };
    }
  }
  if (!best) {
    const error = new Error(`no session log found under ${root}. Pass --log <path> or set WORKBUDDY_SESSION_ID.`);
    error.code = 'ENOLOG';
    throw error;
  }
  const header = readSessionHeader(best.path);
  return { logPath: best.path, sessionId: header?.id, cwd: header?.cwd ?? workspace, header, via: 'newest' };
}

// Kept so imports written against the DSH module surface still resolve.
export function newestLogIn() {
  return undefined;
}
export function encodeSegment(raw) {
  return raw;
}
