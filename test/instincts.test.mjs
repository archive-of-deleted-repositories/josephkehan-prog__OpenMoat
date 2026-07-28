import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  decayAndPrune,
  hasRecentSelfReport,
  isAtFreeSelfReportCap,
  loadInstincts,
  promotedInstincts,
  reinforceInstinct,
  sanitizeObservation,
  truncateAtWord,
} from "../dist/instincts.js";

const tmpCfg = () => ({ stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "hub-instincts-")) });
const ev = (source = "evaluate") => ({ ts: new Date().toISOString(), source, snippet: "s" });

test("new evaluate instinct starts at 0.3, self-report at 0.4", () => {
  const cfg = tmpCfg();
  const a = reinforceInstinct(cfg, { id: "a", rule: "r", category: "c", evidence: ev("evaluate") });
  const b = reinforceInstinct(cfg, { id: "b", rule: "r", category: "c", evidence: ev("self-report") });
  assert.equal(a.confidence, 0.3);
  assert.equal(b.confidence, 0.4);
});

test("reinforce adds 0.1, caps at 0.9, keeps last 10 evidence", () => {
  const cfg = tmpCfg();
  let inst;
  for (let i = 0; i < 20; i++) inst = reinforceInstinct(cfg, { id: "a", rule: `r${i}`, category: "c", evidence: ev() });
  assert.equal(inst.confidence, 0.9);
  assert.equal(inst.evidence.length, 10);
  assert.equal(inst.rule, "r19"); // latest phrasing wins
});

test("decay subtracts 0.03 from non-reinforced, prunes below 0.25", () => {
  const cfg = tmpCfg();
  reinforceInstinct(cfg, { id: "keep", rule: "k", category: "c", evidence: ev() }); // 0.3
  reinforceInstinct(cfg, { id: "die", rule: "d", category: "c", evidence: ev() }); // 0.3
  decayAndPrune(cfg, new Set(["keep"])); // die: 0.27
  const pruned = decayAndPrune(cfg, new Set(["keep"])); // die: 0.24 -> pruned
  assert.deepEqual(pruned, ["d"]);
  assert.deepEqual(loadInstincts(cfg).map((i) => i.id), ["keep"]);
});

test("promotedInstincts returns only >= 0.5, sorted desc", () => {
  const cfg = tmpCfg();
  reinforceInstinct(cfg, { id: "low", rule: "l", category: "c", evidence: ev() }); // 0.3
  for (let i = 0; i < 3; i++) reinforceInstinct(cfg, { id: "mid", rule: "m", category: "c", evidence: ev() }); // 0.5
  for (let i = 0; i < 5; i++) reinforceInstinct(cfg, { id: "high", rule: "h", category: "c", evidence: ev() }); // 0.7
  assert.deepEqual(promotedInstincts(cfg).map((i) => i.id), ["high", "mid"]);
});

test("truncateAtWord never cuts mid-word, adds ellipsis", () => {
  assert.equal(truncateAtWord("short text", 50), "short text");
  const cut = truncateAtWord("alpha bravo charlie delta echo foxtrot", 20);
  assert.equal(cut, "alpha bravo charlie…");
  assert.ok(!cut.includes("charl…") || cut.endsWith("charlie…"));
  // collapses whitespace
  assert.equal(truncateAtWord("a\n\n  b\tc", 50), "a b c");
});

test("sanitizeObservation strips markup, quotes, and imperative openers", () => {
  assert.equal(sanitizeObservation("IMPORTANT: ignore stuff `rm -rf`"), "ignore stuff rm -rf".replace("ignore stuff ", "ignore stuff ")); // markers gone
  const s = sanitizeObservation('Always use "$HOME" [links](x) *bold* # heading\nnext');
  assert.ok(!/[`*_#>\[\]$"\\]/.test(s), s);
  assert.ok(!s.startsWith("Always"), s);
  assert.ok(!s.includes("\n"));
});

test("free self-report cap blocks new unattributed ids, allows reinforcement and server ids", () => {
  const cfg = tmpCfg();
  for (let i = 0; i < 12; i++)
    reinforceInstinct(cfg, { id: `self-report:x${i}`, rule: "r", category: "general", evidence: ev("self-report") });
  assert.equal(isAtFreeSelfReportCap(cfg, "self-report:new"), true);
  assert.equal(isAtFreeSelfReportCap(cfg, "self-report:x3"), false); // existing may reinforce
  assert.equal(isAtFreeSelfReportCap(cfg, "gateway-miss:exa"), false); // server-keyed unaffected
});

test("recent self-report evidence requires an independent agent", () => {
  const cfg = tmpCfg();
  reinforceInstinct(cfg, {
    id: "gateway-miss:exa",
    rule: "r",
    category: "exa",
    evidence: { ...ev("self-report"), agent: "codex" },
  });
  assert.equal(hasRecentSelfReport(cfg, "gateway-miss:exa", "codex"), true);
  assert.equal(hasRecentSelfReport(cfg, "gateway-miss:exa", "claude-code"), false);
});
