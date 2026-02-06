# Release v1.1-hackathon

## Highlights
- EIP-712 gated game creation with player signatures.
- Full dispute/challenge flow with house arbitration (uphold/cancel/override).
- Bond rules for paid vs free games with explicit challenge bond sizing.
- Extensive unit, fuzz, and simulation tests (28 core tests + 6 gameplay simulations).
- Threat model and security checklist included in README.
- Free-play mode supported (stake=0, bond=0) with fixed challenge bond.

## Contract Changes
- Added Disputed status and challenge hooks (`challenge`, `resolveChallengeUphold`, `resolveChallengeCancel`, `resolveChallengeOverride`).
- Enforced `settleDuration >= fundDuration`.
- Enforced bond rules: paid games require `bond > 0`, free games require `bond = 0`.
- Added events for all state transitions and dispute outcomes.
- Added dust handling to house for staking/bond rounding.

## Circuit / Hash
- Circom constraint fixes (single assignment + range/boolean constraints).
- Canonical engine hash now supports BigInt and rejects invalid types.

## Testing
- Foundry tests for:
  - signature integrity and ordering
  - deadlines and liveness behavior
  - challenge outcomes and payouts
  - claimable monotonicity (with and without withdrawals)
  - event emissions
- Simulation suite covering realistic gameplay flows (happy path, disputes, expiry).

## Deployment
- Added `deploy.sh` and Foundry `Deploy.s.sol` script stub.

## Notes
- This release is designed for hackathon use; a full external audit is recommended before mainnet deployment.
