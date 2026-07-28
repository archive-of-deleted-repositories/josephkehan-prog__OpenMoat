import type { ResolvedServer, ServerDef } from "../registry.js";

export interface AdapterResult {
  changed: boolean;
  managed: string[];
  notes: string[];
}

export interface AdapterCtx {
  configPath: string;
  stateDir: string;
  dryRun: boolean;
  prevManaged: string[];
}

/** A server found while READING a harness config (drift adoption, doctor). */
export interface FoundServer {
  name: string;
  def: Partial<ServerDef>;
  /** Whether the harness will actually start/use this configured server. */
  active?: boolean;
  /** Whether this definition can be represented safely in the hub registry. */
  adoptable?: boolean;
  /** Human-readable reason adoption is unsafe or lossy. */
  adoptReason?: string;
}

export interface Adapter {
  id: string;
  sync(servers: ResolvedServer[], ctx: AdapterCtx): AdapterResult;
  /** Parse the harness config and return the servers it currently declares.
   *  Each adapter owns BOTH directions of its format (write in sync, read here)
   *  so the two can't drift apart. */
  readServers(configPath: string): FoundServer[];
}
