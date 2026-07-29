import type { GatewayPolicyRule, OpenMoatConfig } from "./config.js";

export interface GatewayDecision {
  allowed: boolean;
  agent: string;
  target: string;
  reason: string;
}

function matches(pattern: string, server: string, tool: string): boolean {
  return pattern === "*" || pattern === server || pattern === `${server}:*` || pattern === `${server}:${tool}`;
}

function anyMatch(patterns: string[] | undefined, server: string, tool: string): boolean {
  return (patterns ?? []).some((pattern) => matches(pattern, server, tool));
}

function decideRule(rule: GatewayPolicyRule | undefined, server: string, tool: string): boolean | undefined {
  if (!rule) return undefined;
  if (anyMatch(rule.deny, server, tool)) return false;
  if (anyMatch(rule.allow, server, tool)) return true;
  return undefined;
}

export function authorizeGateway(
  cfg: OpenMoatConfig,
  agentName: string | undefined,
  server: string,
  tool = "*",
  serverZone = "default"
): GatewayDecision {
  const agent = agentName?.trim() || "unknown";
  const target = `${server}:${tool}`;
  const policy = cfg.gatewayPolicy;
  if (!policy) return { allowed: true, agent, target, reason: "no gateway policy configured" };

  const agentRule = policy.agents[agent];
  const wildcardRule = policy.agents["*"];
  const callerZone = agentRule?.zone ?? wildcardRule?.zone ?? "default";
  if (callerZone !== serverZone) {
    return {
      allowed: false,
      agent,
      target,
      reason: `zone denied: caller '${callerZone}' cannot access server zone '${serverZone}'`,
    };
  }

  const agentDecision = decideRule(agentRule, server, tool);
  if (agentDecision !== undefined) {
    return {
      allowed: agentDecision,
      agent,
      target,
      reason: `${agentDecision ? "allowed" : "denied"} by agent rule '${agent}'`,
    };
  }

  const wildcardDecision = decideRule(wildcardRule, server, tool);
  if (wildcardDecision !== undefined) {
    return {
      allowed: wildcardDecision,
      agent,
      target,
      reason: `${wildcardDecision ? "allowed" : "denied"} by wildcard agent rule`,
    };
  }

  const allowed = policy.default === "allow";
  return { allowed, agent, target, reason: `${policy.default} by gateway default` };
}

export function requireGatewayAuthorization(
  cfg: OpenMoatConfig,
  agentName: string | undefined,
  server: string,
  tool = "*",
  serverZone = "default"
): GatewayDecision {
  const decision = authorizeGateway(cfg, agentName, server, tool, serverZone);
  if (!decision.allowed) {
    throw new Error(`gateway policy denied '${decision.agent}' access to '${decision.target}' (${decision.reason})`);
  }
  return decision;
}
