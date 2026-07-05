import { describe, expect, it } from "vitest";

import { Agency, AgentSpec, TransportConfig } from "../agency.js";
import { AgencyDeployment, Roster } from "../roster.js";

describe("TransportConfig", () => {
  it("defaults to in_process", () => {
    const t = new TransportConfig();
    expect(t.data.type).toBe("in_process");
    expect(t.toPrompt()).toBe("Transport: in_process");
  });

  it("renders nats transport", () => {
    const t = new TransportConfig({
      type: "nats",
      nats_url: "nats://remote:4222",
    });
    expect(t.toPrompt()).toBe("Transport: NATS (nats://remote:4222)");
  });
});

describe("AgentSpec", () => {
  it("constructs with defaults", () => {
    const a = new AgentSpec({ role: "coder" });
    // No framework default — an unspecified model is undefined (the runner decides).
    expect(a.data.model).toBeUndefined();
    expect(a.data.max_turns).toBe(10);
    expect(a.data.is_coordinator).toBe(false);
  });

  it("toPrompt() renders correctly", () => {
    const a = new AgentSpec({
      role: "reviewer",
      is_coordinator: true,
      capabilities: ["code_review", "linting"],
    });
    const prompt = a.toPrompt();
    expect(prompt).toContain("### Agent: reviewer");
    expect(prompt).toContain("Role: **Coordinator**");
    expect(prompt).toContain("Capabilities: code_review, linting");
  });

  it("renders nested persona and judgment", () => {
    const a = new AgentSpec({
      role: "reviewer",
      persona: { identity: "a reviewer", tone: "direct" },
      judgment: { domain: "code" },
    });
    const prompt = a.toPrompt();
    expect(prompt).toContain("You are a reviewer.");
    expect(prompt).toContain("## Judgment: code");
  });
});

describe("Agency", () => {
  const validAgency = {
    name: "dev-team",
    description: "Development team",
    agents: [
      { role: "coordinator", is_coordinator: true },
      { role: "coder" },
      { role: "reviewer" },
    ],
  };

  it("constructs valid agency", () => {
    const a = new Agency(validAgency);
    expect(a.data.name).toBe("dev-team");
    expect(a.data.agents).toHaveLength(3);
  });

  it("coordinator getter returns coordinator", () => {
    const a = new Agency(validAgency);
    expect(a.coordinator?.role).toBe("coordinator");
  });

  it("internalAgents getter returns non-coordinators", () => {
    const a = new Agency(validAgency);
    expect(a.internalAgents).toHaveLength(2);
    expect(a.internalAgents.map((a) => a.role)).toEqual(["coder", "reviewer"]);
  });

  it("rejects agency with no coordinator", () => {
    expect(
      () =>
        new Agency({
          name: "team",
          agents: [{ role: "a" }, { role: "b" }],
        }),
    ).toThrow("exactly one coordinator");
  });

  it("rejects agency with multiple coordinators", () => {
    expect(
      () =>
        new Agency({
          name: "team",
          agents: [
            { role: "a", is_coordinator: true },
            { role: "b", is_coordinator: true },
          ],
        }),
    ).toThrow("exactly one coordinator");
  });

  it("rejects duplicate roles", () => {
    expect(
      () =>
        new Agency({
          name: "team",
          agents: [{ role: "coder", is_coordinator: true }, { role: "coder" }],
        }),
    ).toThrow("unique");
  });

  it("toPrompt() renders agency", () => {
    const a = new Agency(validAgency);
    const prompt = a.toPrompt();
    expect(prompt).toContain("# Agency: dev-team");
    expect(prompt).toContain("Development team");
    expect(prompt).toContain("## Coordinator");
    expect(prompt).toContain("## Agents");
    expect(prompt).toContain("Transport: in_process");
  });
});

describe("AgencyDeployment", () => {
  const validAgency = {
    name: "team",
    agents: [{ role: "lead", is_coordinator: true }],
  };

  it("renders basic deployment", () => {
    const d = new AgencyDeployment({ agency: validAgency });
    expect(d.toPrompt()).toBe("- team (profile: standard)");
  });

  it("renders isolated deployment", () => {
    const d = new AgencyDeployment({
      agency: validAgency,
      isolated: true,
      resource_profile: "heavy",
    });
    expect(d.toPrompt()).toBe("- team (profile: heavy) [isolated]");
  });
});

describe("Roster", () => {
  const agency1 = {
    name: "team-a",
    agents: [{ role: "lead", is_coordinator: true }],
  };
  const agency2 = {
    name: "team-b",
    agents: [{ role: "lead", is_coordinator: true }],
  };

  it("constructs valid roster", () => {
    const r = new Roster({
      name: "my-roster",
      agencies: [{ agency: agency1 }, { agency: agency2 }],
    });
    expect(r.data.agencies).toHaveLength(2);
  });

  it("rejects duplicate agency names", () => {
    expect(
      () =>
        new Roster({
          name: "my-roster",
          agencies: [{ agency: agency1 }, { agency: agency1 }],
        }),
    ).toThrow("unique");
  });

  it("allAgents returns all agents", () => {
    const r = new Roster({
      name: "my-roster",
      agencies: [{ agency: agency1 }, { agency: agency2 }],
    });
    expect(r.allAgents).toHaveLength(2);
  });

  it("coordinators returns all coordinators", () => {
    const r = new Roster({
      name: "my-roster",
      agencies: [{ agency: agency1 }, { agency: agency2 }],
    });
    expect(r.coordinators).toHaveLength(2);
  });

  it("toPrompt() renders roster", () => {
    const r = new Roster({
      name: "my-roster",
      workspace_id: "ws-123",
      agencies: [{ agency: agency1 }],
    });
    const prompt = r.toPrompt();
    expect(prompt).toContain("# Roster: my-roster");
    expect(prompt).toContain("Workspace: ws-123");
    expect(prompt).toContain("## Agencies");
    expect(prompt).toContain("Transport: NATS");
  });

  it("defaults inter_agency_transport to nats", () => {
    const r = new Roster({ name: "r" });
    expect(r.data.inter_agency_transport.type).toBe("nats");
  });
});
