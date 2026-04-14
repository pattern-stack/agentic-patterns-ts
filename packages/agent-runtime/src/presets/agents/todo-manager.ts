/**
 * Todo Manager agent preset.
 *
 * Provides an in-memory task list managed through five tools:
 * create_task, list_tasks, complete_task, delete_task, update_task.
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

// ---------------------------------------------------------------------------
// TodoToolbox
// ---------------------------------------------------------------------------

export class TodoToolbox extends Toolbox {
  readonly name = "task_management";
  readonly description = "In-memory task list management";

  readonly tools: Record<string, ToolDefinition> = {
    create_task: {
      description: "Create a new task",
      parameters: z.object({
        title: z.string().describe("Task title"),
        description: z.string().optional().describe("Optional task description"),
      }),
      execute: async (args) => {
        const { title, description } = args as { title: string; description?: string };
        const id = `task-${nextId++}`;
        const task: Task = { id, title, description, status: "pending" };
        tasks.set(id, task);
        return { id: task.id, title: task.title, status: task.status };
      },
    },

    list_tasks: {
      description: "List tasks, optionally filtered by status",
      parameters: z.object({
        status: z
          .enum(["pending", "done"])
          .optional()
          .describe("Filter by status (pending or done)"),
      }),
      execute: async (args) => {
        const { status } = args as { status?: "pending" | "done" };
        const all = Array.from(tasks.values());
        const filtered = status ? all.filter((t) => t.status === status) : all;
        return { tasks: filtered };
      },
    },

    complete_task: {
      description: "Mark a task as done",
      parameters: z.object({
        id: z.string().describe("Task ID to complete"),
      }),
      execute: async (args) => {
        const { id } = args as { id: string };
        const task = tasks.get(id);
        if (!task) {
          throw new Error(`Task not found: ${id}`);
        }
        task.status = "done";
        return { ...task };
      },
    },

    delete_task: {
      description: "Delete a task",
      parameters: z.object({
        id: z.string().describe("Task ID to delete"),
      }),
      execute: async (args) => {
        const { id } = args as { id: string };
        if (!tasks.has(id)) {
          throw new Error(`Task not found: ${id}`);
        }
        tasks.delete(id);
        return { deleted: true };
      },
    },

    update_task: {
      description: "Update a task's title or description",
      parameters: z.object({
        id: z.string().describe("Task ID to update"),
        title: z.string().optional().describe("New title"),
        description: z.string().optional().describe("New description"),
      }),
      execute: async (args) => {
        const { id, title, description } = args as {
          id: string;
          title?: string;
          description?: string;
        };
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
    },
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
    .withDefaultModel("sonnet")
    .build();

  const mission = new Mission({
    objective: "Help users manage their task lists efficiently using the provided tools",
    success_criteria: [
      "Tasks created and tracked accurately",
      "Tools used appropriately for all operations",
    ],
  });

  return new AgentBuilder(role).withMission(mission).build();
}
