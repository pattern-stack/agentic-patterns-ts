/**
 * Agent datatype and AgentBuilder - instantiated agent entity.
 *
 * Agent = Role x Background x Awareness x Mission
 *
 * An Agent is a Role instantiated with runtime context.
 */

import { z } from "zod";

import { Awareness, type AwarenessDomainData, AwarenessSchema } from "../atoms/awareness.js";
import { Background, BackgroundSchema } from "../atoms/background.js";
import { AgenticModel } from "../atoms/base.js";
import { type Mission, MissionSchema } from "../atoms/mission.js";
import type { State } from "../atoms/state.js";
import type { ToolSchema } from "../molecules/tool-schema.js";
import {
  BoundariesSection,
  CapabilitiesSection,
  ContextSection,
  IdentitySection,
  MethodologySection,
  MissionSection,
  PromptRenderer,
} from "../rendering/index.js";
import { type Role, RoleSchema } from "./role.js";

/**
 * One rendered prompt section with provenance.
 *
 * `source` says which side of the Agent product contributed the section:
 * - "role" — identity/boundaries/capabilities/methodology come from the Role
 * - "instance" — context/mission come from the instantiation (Background,
 *   Awareness, Mission)
 */
export interface AgentPromptSectionData {
  name: string;
  source: "role" | "instance";
  text: string;
}

export const AgentSchema = z.object({
  role: RoleSchema,
  background: BackgroundSchema.default({}),
  awareness: AwarenessSchema.default({}),
  mission: MissionSchema,
  model: z.string().nullable().default(null),
});

export type AgentData = z.infer<typeof AgentSchema>;

/**
 * Instantiated agent entity.
 *
 * Agent = Role x Background x Awareness x Mission
 *
 * An Agent is a Role instantiated with runtime context.
 * Create new Agent instances for each task/mission.
 */
export class Agent extends AgenticModel<typeof AgentSchema.shape> {
  /** The Role instance. */
  readonly role: Role;
  /** The Background instance. */
  readonly background: Background;
  /** The Awareness instance. */
  readonly awareness: Awareness;
  /** The Mission instance. */
  readonly mission: Mission;

  constructor(data: {
    role: Role;
    background?: Background;
    awareness?: Awareness;
    mission: Mission;
    model?: string | null;
  }) {
    super(AgentSchema, {
      role: data.role.data,
      background: (data.background ?? new Background({})).data,
      awareness: (data.awareness ?? new Awareness({})).data,
      mission: data.mission.data,
      model: data.model ?? null,
    });

    this.role = data.role;
    this.background = data.background ?? new Background({});
    this.awareness = data.awareness ?? new Awareness({});
    this.mission = data.mission;
  }

  /** Get the LLM model to use. */
  getModel(): string {
    return this._data.model ?? this.role.defaultModel;
  }

  /** Get tool definitions from the role. */
  getTools(): ToolSchema[] {
    return this.role.getTools();
  }

  /** Get retrieval guidance from awareness domains. */
  getAwarenessHints(): string[] {
    return this.awareness.data.domains.map(
      (domain: AwarenessDomainData) => `${domain.name}: ${domain.description}`,
    );
  }

  toPrompt(): string {
    return this.renderInitialPrompt();
  }

  /**
   * Render full system prompt for turn 1 via PromptRenderer.
   *
   * Includes all sections. Use when agent has no conversation history.
   */
  renderInitialPrompt(): string {
    return this.renderSections()
      .map((section) => section.text)
      .join("\n\n");
  }

  /**
   * Render the initial prompt as ordered sections with provenance.
   *
   * Mirrors PromptRenderer.renderInitial() exactly — same section order,
   * same non-empty filtering — so joining the texts with "\n\n" reproduces
   * renderInitialPrompt() verbatim (renderInitialPrompt delegates here).
   */
  renderSections(): AgentPromptSectionData[] {
    const renderer = this._buildRenderer();
    const sections: Array<[{ name: string; render(): string }, "role" | "instance"]> = [
      [renderer.identity, "role"],
      [renderer.boundaries, "role"],
      [renderer.capabilities, "role"],
      [renderer.context, "instance"],
      [renderer.mission, "instance"],
      [renderer.methodology, "role"],
    ];
    return sections
      .map(([section, source]) => ({ name: section.name, source, text: section.render() }))
      .filter((section) => section.text !== "");
  }

  /**
   * Render delta system prompt for turn N via PromptRenderer.
   *
   * Only includes state/mission/methodology.
   * Identity/boundaries/capabilities are in conversation history.
   */
  renderContinuationPrompt(state: State): string {
    const renderer = this._buildRenderer();
    return renderer.renderContinuation(state);
  }

  /**
   * Build a PromptRenderer from this agent's components.
   */
  private _buildRenderer(): PromptRenderer {
    return new PromptRenderer(
      new IdentitySection(this.role.persona, [...this.role.responsibilities], this.role.tone),
      new BoundariesSection([...this.role.judgments], this.role.recovery),
      new CapabilitiesSection([...this.role.capabilities]),
      new ContextSection(this.background, this.awareness),
      new MissionSection(this.mission),
      new MethodologySection([...this.role.judgments], this.role.methodology),
    );
  }
}

/**
 * Fluent builder for instantiating Agents.
 *
 * Example:
 *   const agent = new AgentBuilder(pmRole)
 *     .withBackground(teamContext)
 *     .withAwareness(orgAwareness)
 *     .withMission(new Mission({ objective: "Plan Q1 sprint" }))
 *     .withModel("claude-opus-4-20250514")
 *     .build();
 */
export class AgentBuilder {
  private _role: Role;
  private _background: Background = new Background({});
  private _awareness: Awareness = new Awareness({});
  private _mission: Mission | undefined;
  private _model: string | undefined;

  constructor(role: Role) {
    this._role = role;
  }

  withBackground(background: Background): this {
    this._background = background;
    return this;
  }

  withAwareness(awareness: Awareness): this {
    this._awareness = awareness;
    return this;
  }

  withMission(mission: Mission): this {
    this._mission = mission;
    return this;
  }

  withModel(model: string): this {
    this._model = model;
    return this;
  }

  build(): Agent {
    if (!this._mission) {
      throw new Error("Mission is required. Call withMission() before build().");
    }

    return new Agent({
      role: this._role,
      background: this._background,
      awareness: this._awareness,
      mission: this._mission,
      model: this._model,
    });
  }
}
