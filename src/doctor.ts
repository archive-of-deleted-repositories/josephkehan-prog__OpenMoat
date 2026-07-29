import fs from "node:fs";
import { catalogFile } from "./catalog.js";
import type { OpenMoatConfig } from "./config.js";
import { loadSecrets, resolveServers } from "./registry.js";

export interface DoctorCheck {
  status: "ok" | "warning" | "error";
  code: string;
  message: string;
}

export interface DoctorReport {
  ready: boolean;
  checks: DoctorCheck[];
}

export function runDoctor(cfg: OpenMoatConfig): DoctorReport {
  const checks: DoctorCheck[] = [];
  const push = (
    status: DoctorCheck["status"],
    code: string,
    message: string
  ) => checks.push({ status, code, message });

  push("ok", "CONFIG_VALID", `valid Moatfile: ${cfg.configFile}`);
  if (!fs.existsSync(cfg.secretsEnv)) {
    push("warning", "SECRETS_MISSING", `missing ${cfg.secretsEnv}`);
  } else if ((fs.statSync(cfg.secretsEnv).mode & 0o077) !== 0) {
    push(
      "error",
      "SECRETS_PERMISSIONS",
      `${cfg.secretsEnv} must be mode 0600`
    );
  } else {
    push("ok", "SECRETS_PRIVATE", "secrets.env permissions are private");
  }

  const secrets = loadSecrets(cfg.secretsEnv, {
    enforcePermissions: false,
  });
  const { warnings } = resolveServers(cfg.inlineServers, secrets);
  for (const warning of warnings) {
    push("error", "UNRESOLVED_SECRET", warning);
  }

  const trusted = cfg.inlineServers.filter(
    (server) => !server.disabled && server.trusted !== false
  ).length;
  const quarantined = cfg.inlineServers.filter(
    (server) => !server.disabled && server.trusted === false
  ).length;
  push(
    "ok",
    "SERVER_COUNTS",
    `${trusted} trusted, ${quarantined} quarantined, ${
      cfg.inlineServers.length - trusted - quarantined
    } disabled`
  );

  const catalog = catalogFile(cfg);
  if (!fs.existsSync(catalog)) {
    push(
      "warning",
      "CATALOG_MISSING",
      "tool catalog missing; run `moat catalog --refresh`"
    );
  } else {
    const age = Date.now() - fs.statSync(catalog).mtimeMs;
    push(
      age > 7 * 86_400_000 ? "warning" : "ok",
      age > 7 * 86_400_000 ? "CATALOG_STALE" : "CATALOG_READY",
      `tool catalog age ${Math.floor(age / 3_600_000)}h`
    );
  }

  return {
    ready: checks.every((check) => check.status !== "error"),
    checks,
  };
}
