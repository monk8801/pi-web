// The to-do list lives in `pi-web-todos.json` in the agent dir, beside pi's own
// files (`mcp.json`, `settings.json`). It holds what the user typed, so unlike
// the session index it is never rebuilt: writes are serialized in-process,
// locked against other processes, replaced atomically, and a file that cannot
// be read is set aside, never overwritten. The rules live in
// `lib/todos-shared.ts`; this module is the disk.

import { mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { serializeByKey } from "./key-serializer";
import { readRegularFileText } from "./regular-file";
import {
  applyTodoRequest,
  emptyTodosState,
  MAX_TODOS_FILE_BYTES,
  normalizeTodosState,
  TODOS_VERSION,
  type TodoDoneBy,
  type TodoRequest,
  type TodosState,
} from "./todos-shared";

// `__proto__` is never copied: assigning it would set the object's prototype instead.
const KNOWN_KEYS = new Set(["version", "revision", "todos", "__proto__"]);

// Route handlers are bundled separately and hot reload re-evaluates modules; globalThis keeps one queue per process.
const QUEUE_KEY: symbol = Symbol.for("pi-web:todos-write-queue");

/**
 * About three seconds of retries in all, as for `mcp.json` and the session UI
 * state: writes are serialized before the lock, so only another process holds
 * it, and only for one short write. A compromised lock is logged: proper-lockfile's
 * default throws from a timer, which would take the whole server down.
 */
const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the todos lock was compromised: ${error.message}`);
  },
};

/** Another process held the file's lock for longer than the retries wait. */
export class TodosLockedError extends Error {
  constructor(message = "Another process holds the todos lock") {
    super(message);
    this.name = "TodosLockedError";
  }
}

interface CachedRead {
  mtimeMs: number;
  size: number;
  ino: number;
  state: TodosState;
  /** Unknown top-level fields of the file, kept for a newer build when this one writes. */
  extras: Record<string, unknown>;
}

interface TodosCache {
  /** The last read per path, valid while the file's stat fingerprint matches. */
  reads: Map<string, CachedRead>;
  /** The highest revision seen per path, so a reset after a corrupt or removed file still moves forward. */
  revisions: Map<string, number>;
}

declare global {
  var __piWebTodosCache: TodosCache | undefined;
}

function cache(): TodosCache {
  return (globalThis.__piWebTodosCache ??= { reads: new Map(), revisions: new Map() });
}

function noteRevision(path: string, revision: number): void {
  const revisions = cache().revisions;
  if (revision > (revisions.get(path) ?? -1)) revisions.set(path, revision);
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

export function getTodosPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web-todos.json");
}

type Parsed = { ok: true; state: TodosState; raw: Record<string, unknown> } | { ok: false };

function parseStateText(text: string): Parsed {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false };
  }
  const state = normalizeTodosState(raw);
  return state ? { ok: true, state, raw: raw as Record<string, unknown> } : { ok: false };
}

/**
 * What the file holds, without ever throwing on its contents:
 * `missing` when nothing is there, `unreadable` when it is not a regular file,
 * is past `MAX_TODOS_FILE_BYTES`, or cannot be opened, and `corrupt` when the
 * bytes are not this build's state.
 */
type Loaded =
  | { kind: "missing" }
  | { kind: "unreadable"; message: string }
  | { kind: "corrupt" }
  | { kind: "state"; state: TodosState; raw: Record<string, unknown> };

/** Callers get their own copy: the cached state is shared by every later read. */
function copyState(state: TodosState): TodosState {
  return structuredClone(state);
}

/**
 * The file's contents through the stat-keyed cache, so a poll costs one stat
 * while nothing changed. A file too large or not a regular file is
 * `unreadable`, not a thrown error: the caller decides whether that means an
 * empty read or a file to set aside.
 */
function loadTodos(path: string): Loaded {
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      cache().reads.delete(path);
      return { kind: "missing" };
    }
    return { kind: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  const cached = cache().reads.get(path);
  // An atomic replace gives the file a new inode, so a write within the mtime's granularity is still seen.
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size && cached.ino === stats.ino) {
    return { kind: "state", state: copyState(cached.state), raw: { ...cached.extras } };
  }
  let text: string | undefined;
  try {
    // Read after the stat: a write in between leaves a fingerprint older than the text, which only costs one more read.
    text = readRegularFileText(path, MAX_TODOS_FILE_BYTES);
  } catch (error) {
    cache().reads.delete(path);
    return { kind: "unreadable", message: error instanceof Error ? error.message : String(error) };
  }
  if (text === undefined) {
    cache().reads.delete(path);
    return { kind: "missing" };
  }
  const parsed = parseStateText(text);
  if (!parsed.ok) {
    cache().reads.delete(path);
    return { kind: "corrupt" };
  }
  noteRevision(path, parsed.state.revision);
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed.raw)) {
    if (!KNOWN_KEYS.has(key)) extras[key] = value;
  }
  cache().reads.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, state: copyState(parsed.state), extras });
  return { kind: "state", state: parsed.state, raw: extras };
}

/** Never throws; missing, corrupt or unreadable all read as empty (a read never rewrites the file). */
export function readTodos(path?: string): TodosState {
  let target: string;
  try {
    target = path ?? getTodosPath();
  } catch (error) {
    console.warn(`[pi-web] could not locate the todos file: ${error instanceof Error ? error.message : String(error)}`);
    return emptyTodosState();
  }
  const loaded = loadTodos(target);
  switch (loaded.kind) {
    case "state":
      return loaded.state;
    case "unreadable":
      console.warn(`[pi-web] ${target} cannot be read as todos state: ${loaded.message}`);
      return emptyTodosState();
    case "corrupt":
      console.warn(`[pi-web] ${target} is not valid todos state; reading it as empty until the next change sets it aside`);
      return emptyTodosState();
    default:
      return emptyTodosState();
  }
}

/** Sets a file the store cannot read aside beside itself; best effort. */
function backUpUnreadableFile(path: string, reason: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.warn(`[pi-web] ${path} ${reason}; moved it to ${backup} and started from an empty todos list`);
  } catch (error) {
    console.warn(`[pi-web] ${path} ${reason} and could not be moved aside (${error instanceof Error ? error.message : String(error)}); starting from an empty todos list`);
  }
}

export interface UpdateTodosOptions {
  path?: string;
  now?: number;
  newId?: () => string;
  /** Who a `complete` is attributed to: "user" for a click, "agent" for the tool. */
  doneBy?: TodoDoneBy;
}

/**
 * Locks, reads, applies `request`, and replaces the file when it changed
 * something, with the revision bumped. Unknown top-level fields of a valid file
 * are kept for a newer build.
 */
export function updateTodos(request: TodoRequest, options: UpdateTodosOptions = {}): Promise<TodosState> {
  let target: string;
  try {
    target = options.path ?? getTodosPath();
  } catch (error) {
    return Promise.reject(error);
  }
  const now = options.now ?? Date.now();
  return serializeByKey(QUEUE_KEY, target, async () => {
    mkdirSync(dirname(target), { recursive: true });
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(target, LOCK_OPTIONS);
    } catch (error) {
      if (errorCode(error) === "ELOCKED") throw new TodosLockedError();
      throw error;
    }
    try {
      const lastRevision = cache().revisions.get(target) ?? 0;
      const loaded = loadTodos(target);
      let state: TodosState;
      const extras: Record<string, unknown> = {};
      let reset = false;
      if (loaded.kind === "state") {
        state = loaded.state;
        for (const [key, value] of Object.entries(loaded.raw)) {
          if (!KNOWN_KEYS.has(key)) extras[key] = value;
        }
      } else if (loaded.kind === "missing") {
        // A removed file starts over, but its revision keeps counting so clients notice.
        state = { ...emptyTodosState(), revision: lastRevision };
      } else {
        // Corrupt, too large or not a regular file: it is not a state this build
        // can use, so it is set aside and the list starts empty rather than every
        // write being refused for good.
        backUpUnreadableFile(target, loaded.kind === "corrupt" ? "could not be parsed" : `cannot be read (${loaded.message})`);
        cache().reads.delete(target);
        state = { ...emptyTodosState(), revision: lastRevision + 1 };
        // The file was moved away: write the fresh state even when the edit itself changes nothing.
        reset = true;
      }
      const next = applyTodoRequest(state, request, {
        now,
        ...(options.newId ? { newId: options.newId } : {}),
        ...(options.doneBy ? { doneBy: options.doneBy } : {}),
      });
      // `applyTodoRequest` returns the state itself when nothing changed: that identity is the only "do not write" signal.
      const changed = next !== state;
      if (!changed && !reset) return state;
      const result: TodosState = {
        version: TODOS_VERSION,
        revision: state.revision + (changed ? 1 : 0),
        todos: next.todos,
      };
      const document = {
        version: result.version,
        revision: result.revision,
        todos: result.todos,
        ...extras,
      };
      writePrivateFileAtomicSync(target, JSON.stringify(document, null, 2) + "\n");
      noteRevision(target, result.revision);
      try {
        const stats = statSync(target);
        cache().reads.set(target, { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino, state: copyState(result), extras });
      } catch {
        cache().reads.delete(target);
      }
      return copyState(result);
    } finally {
      try {
        await release();
      } catch {
        // A compromised lock was already reported through onCompromised.
      }
    }
  });
}

/**
 * Cheap enough for the running poll: one stat while the file is unchanged. 0
 * when there is no file, null when one is there but cannot be read (so a caller
 * can tell "nothing yet" from "something is wrong").
 */
export function getTodosRevision(path?: string): number | null {
  try {
    const target = path ?? getTodosPath();
    const loaded = loadTodos(target);
    switch (loaded.kind) {
      case "state":
        return loaded.state.revision;
      case "missing":
        return 0;
      case "corrupt":
        return 0;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function resetTodosCacheForTests(): void {
  globalThis.__piWebTodosCache = undefined;
}
