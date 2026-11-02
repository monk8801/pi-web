// 待办清单存在 `pi-web-todos.json`（agent 目录下，与 mcp.json、settings.json 同级）。
// 它记录的是用户输入，所以不重建：写入在进程内排队、跨进程加锁、原子替换，
// 读不出来的文件被移到一边而不是被覆盖。规则在 `lib/todos-shared.ts`。

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
  normalizeTodosState,
  TODOS_VERSION,
  type TodoDoneBy,
  type TodoRequest,
  type TodosState,
} from "./todos-shared";

const MAX_BYTES = 4 * 1024 * 1024;
// `__proto__` 永不复制：赋值它会改掉对象原型而不是加一个字段。
const KNOWN_KEYS = new Set(["version", "revision", "todos", "__proto__"]);

// 路由处理器分别打包，热更新会重新求值模块；globalThis 保证每个进程只有一条队列。
const QUEUE_KEY: symbol = Symbol.for("pi-web:todos-write-queue");

/**
 * 与 `mcp.json`、会话界面状态相同：写入在取锁前已排队，锁只可能被另一个进程
 * 短暂持有。被破坏的锁只记日志，不抛出——proper-lockfile 默认从定时器抛错，
 * 那会让整个服务停下来。
 */
const LOCK_OPTIONS = {
  realpath: false,
  stale: 10_000,
  retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
  onCompromised: (error: Error) => {
    console.warn(`[pi-web] the todos lock was compromised: ${error.message}`);
  },
};

/** 另一个进程持锁超过了重试等待的时间。 */
export class TodosLockedError extends Error {
  constructor(message = "Another process holds the todos lock") {
    super(message);
    this.name = "TodosLockedError";
  }
}

interface TodosCache {
  /** 每个路径见过的最高 revision，文件被移走后 revision 仍向前走。 */
  revisions: Map<string, number>;
}

declare global {
  var __piWebTodosCache: TodosCache | undefined;
}

function cache(): TodosCache {
  return (globalThis.__piWebTodosCache ??= { revisions: new Map() });
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

/** 从不抛出的读：缺失或损坏都算空（读绝不改写文件）。 */
export function readTodos(path?: string): TodosState {
  let target: string;
  try {
    target = path ?? getTodosPath();
  } catch (error) {
    console.warn(`[pi-web] could not locate the todos file: ${error instanceof Error ? error.message : String(error)}`);
    return emptyTodosState();
  }
  let text: string | undefined;
  try {
    text = readRegularFileText(target, MAX_BYTES);
  } catch (error) {
    console.warn(`[pi-web] could not read the todos file: ${error instanceof Error ? error.message : String(error)}`);
    return emptyTodosState();
  }
  if (text === undefined) return emptyTodosState();
  const parsed = parseStateText(text);
  if (parsed.ok) {
    noteRevision(target, parsed.state.revision);
    return parsed.state;
  }
  console.warn(`[pi-web] ${target} is not valid todos state; reading it as empty until the next change sets it aside`);
  return emptyTodosState();
}

/** 把读不出来的文件挪到旁边；尽力而为。 */
function backUpCorruptFile(path: string): void {
  const backup = `${path}.corrupt-${Date.now()}`;
  try {
    renameSync(path, backup);
    console.warn(`[pi-web] ${path} could not be parsed; moved it to ${backup} and started from an empty todos list`);
  } catch (error) {
    console.warn(`[pi-web] ${path} could not be parsed and could not be moved aside (${error instanceof Error ? error.message : String(error)}); starting from an empty todos list`);
  }
}

export interface UpdateTodosOptions {
  path?: string;
  now?: number;
  newId?: () => string;
  /** `complete` 的署名：人点的是 "user"，agent 调工具的是 "agent"。 */
  doneBy?: TodoDoneBy;
}

/**
 * 加锁读改写：真正改变了状态时 revision +1 并原子替换文件，没改变就不写。
 * 有效文件里不认识的顶层字段（`extras`）原样留给更新的版本。
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
      const text = readRegularFileText(target, MAX_BYTES);
      let state: TodosState;
      const extras: Record<string, unknown> = {};
      let reset = false;
      if (text === undefined) {
        // 文件被删掉了就从空开始，但 revision 继续向前，客户端才看得见。
        state = { ...emptyTodosState(), revision: lastRevision };
      } else {
        const parsed = parseStateText(text);
        if (parsed.ok) {
          state = parsed.state;
          for (const [key, value] of Object.entries(parsed.raw)) {
            if (!KNOWN_KEYS.has(key)) extras[key] = value;
          }
        } else {
          backUpCorruptFile(target);
          state = { ...emptyTodosState(), revision: lastRevision + 1 };
          // 文件已经挪走：即使这次请求本身什么都没改，也要写回一份干净的空状态。
          reset = true;
        }
      }
      const next = applyTodoRequest(state, request, {
        now,
        ...(options.newId ? { newId: options.newId } : {}),
        ...(options.doneBy ? { doneBy: options.doneBy } : {}),
      });
      // `applyTodoRequest` 没改变时返回同一个对象：这是「不写」的唯一判据。
      const changed = next !== state;
      if (!changed && !reset) return state;
      const document = {
        version: TODOS_VERSION,
        revision: state.revision + (changed ? 1 : 0),
        todos: next.todos,
        ...extras,
      };
      writePrivateFileAtomicSync(target, JSON.stringify(document, null, 2) + "\n");
      noteRevision(target, document.revision);
      return { version: TODOS_VERSION, revision: document.revision, todos: next.todos };
    } finally {
      try {
        await release();
      } catch {
        // 被破坏的锁已经通过 onCompromised 记录过了。
      }
    }
  });
}

/** 给 `GET` 用的便宜读：文件不在就是 0，其他意外错误为 null。 */
export function getTodosRevision(path?: string): number | null {
  try {
    const target = path ?? getTodosPath();
    try {
      statSync(target);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT" || code === "ENOTDIR") return 0;
      return null;
    }
    return readTodos(target).revision;
  } catch {
    return null;
  }
}

export function resetTodosCacheForTests(): void {
  globalThis.__piWebTodosCache = undefined;
}
