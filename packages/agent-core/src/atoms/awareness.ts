/**
 * Awareness datatype - what the agent CAN know.
 */

import { z } from "zod";

import { AgenticModel, type RenderContext } from "./base.js";

export const AwarenessDomainSchema = z.object({
  name: z.string(),
  description: z.string(),
  accessMethod: z.string(),
});

export type AwarenessDomainData = z.infer<typeof AwarenessDomainSchema>;

/**
 * A single information source the agent can access.
 */
export class AwarenessDomain extends AgenticModel<typeof AwarenessDomainSchema.shape> {
  constructor(data: z.input<typeof AwarenessDomainSchema>) {
    super(AwarenessDomainSchema, data);
  }

  toPrompt(): string {
    return `- **${this.data.name}**: ${this.data.description} (via ${this.data.accessMethod})`;
  }
}

export const AwarenessSchema = z.object({
  domains: z.array(AwarenessDomainSchema).default([]),
  explorationCapabilities: z.array(z.string()).default([]),
});

export type AwarenessData = z.infer<typeof AwarenessSchema>;

/**
 * A scope-derived render hook attached to an Awareness INSTANCE (not schema
 * data — Zod-validated frozen data can't carry functions). See
 * {@link Awareness.fromScope}.
 */
export type AwarenessScopeRenderFn = (scope: Record<string, unknown>) => string;

/**
 * Defines what the agent CAN know - available information sources.
 */
export class Awareness extends AgenticModel<typeof AwarenessSchema.shape> {
  /**
   * Optional render-time hook: when set AND a render `ctx.scope` is
   * supplied, `toPrompt(ctx)` appends this fn's output after the existing
   * content (never reorders or replaces it). Instance-carried rather than
   * schema data, so `replace()` is overridden below to keep it alive across
   * `withDomain`/`withDomains`/`withCapabilities` (which all rebuild via
   * `replace()`).
   */
  readonly scopeRender?: AwarenessScopeRenderFn;

  constructor(data: z.input<typeof AwarenessSchema>, scopeRender?: AwarenessScopeRenderFn) {
    super(AwarenessSchema, data);
    this.scopeRender = scopeRender;
  }

  /**
   * Build an Awareness whose `toPrompt(ctx)` appends scope-derived text when
   * a render-time `ctx.scope` is supplied.
   *
   * `scopeLike` is a typing anchor ONLY — typically a `SessionScope`
   * instance (or anything shaped `{ parse(input): T }`). It types `fn`'s
   * `scope` parameter via inference and is NEVER parsed here; the scope
   * value arriving through `RenderContext.scope` at render time is trusted
   * as already parsed (same "cast, not validation" stance as `readScopeAs`
   * in `@agentic-patterns/runtime`). Atoms never import molecules, so
   * `scopeLike` is typed structurally rather than as `SessionScope` itself.
   */
  static fromScope<S extends { parse(input: unknown): unknown }>(
    _scopeLike: S,
    fn: (scope: ReturnType<S["parse"]>) => string,
    base?: z.input<typeof AwarenessSchema>,
  ): Awareness {
    return new Awareness(base ?? {}, fn as unknown as AwarenessScopeRenderFn);
  }

  /** Get list of domain names. */
  get domainNames(): string[] {
    return this.data.domains.map((d) => d.name);
  }

  /** Check if agent can access a domain. */
  canAccess(domainName: string): boolean {
    return this.domainNames.includes(domainName);
  }

  /** Get domain by name. */
  getDomain(domainName: string): AwarenessDomainData | undefined {
    return this.data.domains.find((d) => d.name === domainName);
  }

  /**
   * @param ctx - Optional render context. When both `scopeRender` (this
   *   instance) and `ctx.scope` (this call) exist, the scope-derived text is
   *   APPENDED after the existing content — including the no-sources
   *   fallback line below — separated by a blank line, never reordering or
   *   replacing anything. An empty-string result from `scopeRender` is
   *   skipped. Omitting `ctx` (or a `scopeRender`-less instance) renders
   *   byte-identically to the pre-scope behavior.
   */
  toPrompt(ctx?: RenderContext): string {
    let base: string;
    if (this.data.domains.length === 0) {
      base = "You have no external information sources available.";
    } else {
      const lines: string[] = ["## Available Information Sources", "", "You can access:"];
      for (const d of this.data.domains) {
        const domain = new AwarenessDomain(d);
        lines.push(domain.toPrompt());
      }
      if (this.data.explorationCapabilities.length > 0) {
        lines.push(`\nMethods: ${this.data.explorationCapabilities.join(", ")}`);
      }
      base = lines.join("\n");
    }

    if (this.scopeRender && ctx?.scope !== undefined) {
      const extra = this.scopeRender(ctx.scope as Record<string, unknown>);
      if (extra !== "") {
        return `${base}\n\n${extra}`;
      }
    }
    return base;
  }

  /**
   * Overridden because {@link AgenticModel.replace} reconstructs via the
   * 1-arg schema-data constructor and would silently drop `scopeRender` (an
   * instance field, not schema data) on every `withDomain`/`withDomains`/
   * `withCapabilities` call, which all build on `replace()`.
   */
  override replace(updates: Partial<AwarenessData>): this {
    // `this.constructor` (not a hardcoded `new Awareness`) so a downstream
    // subclass keeps its identity through withDomain/withDomains/
    // withCapabilities — same contract as `AgenticModel.replace`.
    const Ctor = this.constructor as new (
      data: z.input<typeof AwarenessSchema>,
      scopeRender?: AwarenessScopeRenderFn,
    ) => this;
    return new Ctor({ ...this.data, ...updates }, this.scopeRender);
  }

  /** Add a single domain to this awareness. */
  withDomain(domain: z.input<typeof AwarenessDomainSchema>): Awareness {
    return this.replace({
      domains: [...this.data.domains, domain],
    });
  }

  /** Add multiple domains to this awareness. */
  withDomains(domains: z.input<typeof AwarenessDomainSchema>[]): Awareness {
    return this.replace({
      domains: [...this.data.domains, ...domains],
    });
  }

  /** Add exploration capabilities to this awareness. */
  withCapabilities(capabilities: string[]): Awareness {
    return this.replace({
      explorationCapabilities: [...this.data.explorationCapabilities, ...capabilities],
    });
  }
}
