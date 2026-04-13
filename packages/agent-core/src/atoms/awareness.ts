/**
 * Awareness datatype - what the agent CAN know.
 */

import { z } from "zod";

import { AgenticModel } from "./base.js";

export const AwarenessDomainSchema = z.object({
  name: z.string(),
  description: z.string(),
  access_method: z.string(),
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
    return `- **${this.data.name}**: ${this.data.description} (via ${this.data.access_method})`;
  }
}

export const AwarenessSchema = z.object({
  domains: z.array(AwarenessDomainSchema).default([]),
  exploration_capabilities: z.array(z.string()).default([]),
});

export type AwarenessData = z.infer<typeof AwarenessSchema>;

/**
 * Defines what the agent CAN know - available information sources.
 */
export class Awareness extends AgenticModel<typeof AwarenessSchema.shape> {
  constructor(data: z.input<typeof AwarenessSchema>) {
    super(AwarenessSchema, data);
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

  toPrompt(): string {
    if (this.data.domains.length === 0) {
      return "You have no external information sources available.";
    }
    const lines: string[] = ["## Available Information Sources", "", "You can access:"];
    for (const d of this.data.domains) {
      const domain = new AwarenessDomain(d);
      lines.push(domain.toPrompt());
    }
    if (this.data.exploration_capabilities.length > 0) {
      lines.push(`\nMethods: ${this.data.exploration_capabilities.join(", ")}`);
    }
    return lines.join("\n");
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
      exploration_capabilities: [...this.data.exploration_capabilities, ...capabilities],
    });
  }
}
