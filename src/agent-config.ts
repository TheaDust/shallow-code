/** The three model-backed roles. Order is the user-facing order. */
export const AGENT_ROLES = ["grouper", "builder", "verifier"] as const;

export type AgentRole = (typeof AGENT_ROLES)[number];

export const AGENT_LABELS: Record<AgentRole, string> = {
  grouper: "Grouper",
  builder: "Builder",
  verifier: "Verifier",
};

/** Canonical environment prefix for each role's model gateway and prices. */
export const AGENT_ENV_PREFIX: Record<AgentRole, string> = {
  grouper: "SHALLOW_GROUPER",
  builder: "SHALLOW_BUILDER",
  verifier: "SHALLOW_VERIFIER",
};

export function isAgentRole(value: string): value is AgentRole {
  return (AGENT_ROLES as readonly string[]).includes(value);
}

/** Canonical name, used in diagnostics and documentation. */
export function agentEnvName(role: AgentRole, suffix: string): string {
  return `${AGENT_ENV_PREFIX[role]}_${suffix}`;
}

/** Read the role's value; blank values are absent. */
export function agentEnv(
  env: Record<string, string | undefined>,
  role: AgentRole,
  suffix: string,
): string | undefined {
  return env[agentEnvName(role, suffix)]?.trim() || undefined;
}
