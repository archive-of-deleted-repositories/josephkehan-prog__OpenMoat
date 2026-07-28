# OpenMoat TypeScript 0.1 TDD Evidence

Source: user-approved OpenMoat Multi-Language Program.

## Journeys

- A user selects one versioned global `Moatfile` with deterministic precedence.
- Core features are on and optional shared-brain features are off by default.
- Reconciliation planning is pure and filesystem effects use an apply
  interface.
- Legacy migration copies configuration only.
- Chezmoi export works without requiring or invoking chezmoi.
- The reference gateway produces the same normalized results as every
  prototype.

RED: after the extracted 52-test baseline passed, the new tests failed because
`dist/integrations.js` and `dist/reconcile.js` did not exist and the legacy
loader could not parse YAML.

GREEN: `npm test` passed 60 tests; the shared runner passed all 12 vendored
gateway cases.

Coverage: the 0.1 contract/core boundary (`config`, `reconcile`,
`integrations`, `policy`, and `registry`) is held to 80% line, branch, and
function coverage. Retained optional shared-brain modules keep their inherited
behavioral tests but are not represented as newly implemented 0.1 core code.

