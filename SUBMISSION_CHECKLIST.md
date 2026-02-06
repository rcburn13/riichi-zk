# Hackathon Submission Checklist

## Core Assets
- [ ] Repo is public and accessible
- [ ] README includes overview, threat model, and security checklist
- [ ] Deployment instructions present (`deploy.sh` or `Deploy.s.sol`)
- [ ] Release notes included (`RELEASE_NOTES.md`)

## Smart Contract
- [ ] Deployed verifier address documented
- [ ] `ENGINE_VERSION_HASH` documented
- [ ] `house` (arbiter) address documented
- [ ] Network/chainId confirmed

## Testing
- [ ] `FOUNDRY_OFFLINE=true forge test --summary` passes
- [ ] Simulation tests pass (`RiichiSettlementSimTest`)

## Demo Readiness
- [ ] Demo flow scripted (create → fund → settle → finalize)
- [ ] Dispute flow scripted (challenge → uphold/cancel/override)
- [ ] Screenshots or logs prepared

## Optional
- [ ] Short architecture diagram in README
- [ ] One-page pitch deck or slide
