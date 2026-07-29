# OpenMoat v1 release checklist

No tag, push, package publication, or release creation is implied by this
checklist. Those are separate maintainer actions.

## Automated gate

- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run test:coverage`
- [ ] `npm audit`
- [ ] `gitleaks detect --no-banner --redact`
- [ ] `git diff --check`
- [ ] npm package contains no Python, source secrets, runtime state, or retired
      product surface
- [ ] clean-room package install can run `moat --help`, `moat init`, and
      `moat validate`

`npm run verify` runs these checks and package smoke tests.

## Protocol and red-team gate

- [ ] legacy outward to modern downstream
- [ ] stateless outward to legacy downstream
- [ ] stateless outward to stateless downstream
- [ ] unauthorized call fails before spawn
- [ ] secret-bearing structured result is recursively redacted
- [ ] oversized result is bounded and cross-caller fetch fails
- [ ] malformed and retired Moatfile fields fail
- [ ] symlink cwd escape fails
- [ ] pool, timeout, breaker, and cleanup behavior passes
- [ ] interactive OAuth callback completes against a controlled test issuer
- [ ] OAuth cancellation/timeout closes the callback listener
- [ ] process inspection shows no fixture descendants after server EOF

## Maintainer approval

- [ ] mission and exclusions match the README
- [ ] release evidence names exact commit and clean worktree state
- [ ] signed GREEN commit exists
- [ ] version and changelog are approved
- [ ] tag is signed
- [ ] package publication is explicitly approved
- [ ] repository remote and destination are explicitly approved
