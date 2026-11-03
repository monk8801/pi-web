// The tool that closes a to-do: `todo_complete`.
//
// A session started from a to-do gets this extension and no other session does,
// so the tool's presence is itself the instruction — the model never has to be
// told an id. It takes no arguments, and it writes the completion through the
// same store the panel reads (`lib/todos.ts`), stamped `doneBy: "agent"`.
//
// The prompt asks for it (`todoStartPrompt`), and a run that ends without it is
// left to the human: the panel shows "awaiting confirmation" and a click marks
// it done, so a half-finished run never closes itself.

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type AgentToolResult, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { getTodosPath, readTodos, updateTodos } from "./todos";

export const TODO_COMPLETE_TOOL_NAME = "todo_complete";
export const TODO_COMPLETE_EXTENSION_NAME = "pi-web-todos";

export interface TodoCompleteExtensionOptions {
  /** The to-do this session was started from. */
  todoId: string;
  /** Tests only: the file to write instead of the agent dir's. */
  path?: string;
}

/** What the result carries; `revision` only when the store actually wrote. */
type TodoCompleteDetails = { todoId: string; revision?: number } | undefined;

export function createTodoCompleteExtension(options: TodoCompleteExtensionOptions): InlineExtension {
  return {
    name: TODO_COMPLETE_EXTENSION_NAME,
    hidden: true,
    factory: (pi) => {
      pi.registerTool(defineTool({
        name: TODO_COMPLETE_TOOL_NAME,
        label: "Complete todo",
        description: "Mark the to-do this session was started from as done. Call it once, after the work is finished and verified. It takes no arguments.",
        parameters: Type.Object({}),
        async execute(): Promise<AgentToolResult<TodoCompleteDetails>> {
          const path = options.path ?? getTodosPath();
          const known = readTodos(path).todos.find((todo) => todo.id === options.todoId);
          if (!known) {
            // The to-do was deleted while the session ran: say so, do not throw.
            return {
              content: [{ type: "text" as const, text: `No such todo: ${options.todoId}` }],
              details: undefined,
              isError: true,
            };
          }
          if (known.status === "done") {
            return {
              content: [{ type: "text" as const, text: `Todo already done: ${known.title}` }],
              details: { todoId: known.id },
            };
          }
          const state = await updateTodos({ action: "complete", id: options.todoId }, { path, doneBy: "agent" });
          return {
            content: [{ type: "text" as const, text: `Todo done: ${known.title}` }],
            details: { todoId: known.id, revision: state.revision },
          };
        },
      }));
    },
  };
}
