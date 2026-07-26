/**
 * Todo Manager agent preset.
 *
 * Provides an in-memory task list managed through five tools:
 * create_task, list_tasks, complete_task, delete_task, update_task.
 *
 * NO MODEL (#179/#222): pins no model. It runs on whatever model the runner
 * resolves (tier / `AGENT_MODEL` / gateway / profiles). Pin one explicitly with
 * `buildTodoAgent().withModel(id)` if you need a specific model.
 */

import {
  AgentBuilder,
  Capability,
  Judgment,
  Mission,
  Persona,
  Responsibility,
  RoleBuilder,
  type ToolDefinition,
  Toolbox,
  defineTool,
} from "@agentic-patterns/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// In-memory task store
// ---------------------------------------------------------------------------

interface Task {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "done";
}

const tasks = new Map<string, Task>();
let nextId = 1;

/** Wire shape of a task — the `returns` contract for the mutating tools. */
const TaskShape = z.object({
  id: z.string().describe("Task ID"),
  title: z.string().describe("Task title"),
  description: z.string().optional().describe("Optional task description"),
  status: z.enum(["pending", "done"]).describe("Current status"),
});

// ---------------------------------------------------------------------------
// TodoToolbox
// ---------------------------------------------------------------------------

// `TodoToolbox` stays a class: it is exported from the package barrel, so
// collapsing it into a `toolbox()` literal would be a breaking API change. The
// tools inside it use `defineTool` — typed args, no hand-casts, and `returns`
// validated on the way out.
export class TodoToolbox extends Toolbox {
  readonly name = "task_management";
  readonly description = "In-memory task list management";

  readonly tools: Record<string, ToolDefinition> = {
    create_task: defineTool({
      description: "Create a new task",
      parameters: z.object({
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Optional task description"),
      }),
      returns: TaskShape.pick({ id: true, title: true, status: true }),
      execute: async ({ title, description }) => {
        const id = `task-${nextId++}`;
        const task: Task = { id, title, description, status: "pending" };
        tasks.set(id, task);
        return { id: task.id, title: task.title, status: task.status };
      },
    }),

    list_tasks: defineTool({
      description: "List tasks, optionally filtered by status",
      parameters: z.object({
        status: z
          .enum(["pending", "done"])
          .optional()
          .describe("Filter by status (pending or done)"),
      }),
      returns: z.object({ tasks: z.array(TaskShape).describe("Matching tasks") }),
      execute: async ({ status }) => {
        const all = Array.from(tasks.values());
        const filtered = status ? all.filter((t) => t.status === status) : all;
        return { tasks: filtered };
      },
    }),

    complete_task: defineTool({
      description: "Mark a task as done",
      parameters: z.object({
        id: z.string().describe("Task ID to complete"),
      }),
      returns: TaskShape,
      execute: async ({ id }) => {
        const task = tasks.get(id);
        if (!task) {
          throw new Error(`Task not found: ${id}`);
        }
        task.status = "done";
        return { ...task };
      },
    }),

    delete_task: defineTool({
      description: "Delete a task",
      parameters: z.object({
        id: z.string().describe("Task ID to delete"),
      }),
      returns: z.object({ deleted: z.boolean().describe("True when the task was removed") }),
      execute: async ({ id }) => {
        if (!tasks.has(id)) {
          throw new Error(`Task not found: ${id}`);
        }
        tasks.delete(id);
        return { deleted: true };
      },
    }),

    update_task: defineTool({
      description: "Update a task's title or description",
      parameters: z.object({
        id: z.string().describe("Task ID to update"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
      }),
      returns: TaskShape,
      execute: async ({ id, title, description }) => {
        const task = tasks.get(id);
        if (!task) {
          throw new Error(`Task not found: ${id}`);
        }
        if (title !== undefined) {
          task.title = title;
        }
        if (description !== undefined) {
          task.description = description;
        }
        return { ...task };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// buildTodoAgent
// ---------------------------------------------------------------------------

export function buildTodoAgent() {
  const role = new RoleBuilder("todo-manager")
    .withPersona(
      new Persona({
        identity: "An organized task manager that keeps things structured",
        tone: "helpful and structured",
        priorities: ["organization", "clarity", "completeness"],
        principles: [
          "Always confirm what was done after each action",
          "List remaining tasks proactively when asked about status",
        ],
      }),
    )
    .withJudgment(
      new Judgment({
        domain: "task and project management",
        heuristics: ["Use the provided tools for all task operations"],
        constraints: ["Only manage tasks using the available tools"],
      }),
    )
    .withCapability(new Capability("task_management", "Task Management", new TodoToolbox()))
    .withResponsibility(
      new Responsibility({
        key: "manage-tasks",
        name: "Manage Tasks",
        description: "Manage tasks — create, update, complete, and organize",
      }),
    )
    .build();

  const mission = new Mission({
    objective: "Help users manage their task lists efficiently using the provided tools",
    successCriteria: [
      "Tasks created and tracked accurately",
      "Tools used appropriately for all operations",
    ],
  });

  return new AgentBuilder(role).withMission(mission).build();
}
