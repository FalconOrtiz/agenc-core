# False-positive library

Check every candidate against this library *before* the walkthrough (cheap kill) and
again before G3 (expensive kill). Matching a pattern kills the candidate unless you can
state, concretely, why the pattern does not apply. Kills are logged in
`logs/bad-attempts.md` — they are permanent filters for future campaigns.

Signal:noise on raw LLM audits is ≈ 1:50 (Heelan's measurement). This library is how you
beat that base rate.

## Reachability FPs

- **Dead code**: no caller chain from any entry point. Prove with a caller grep, not vibes.
- **Config-gated off**: behind a flag/ifdef disabled in every shipped configuration.
- **Trust-boundary mismatch**: the "attacker input" is actually a trusted source (config
  file readable only by root, internal RPC on a loopback-only admin socket).
- **Unreachable-by-protocol**: the state machine never emits the required sequence
  (e.g., handler only runs after a check that already rejects the bad value).

## Sanitizer-already-present FPs

- Validation exists one layer up (middleware, framework auto-escape, ORM binding) — verify
  by *sending the payload and observing the actual query/command*, never by reading one
  function.
- Length check you dismissed is actually correct: recompute it with the real types and
  widths, including the signed/unsigned conversions.
- The dangerous-looking call is bounded by a constant smaller than the destination.

## Environment FPs

- **Harness bugs**: crash is in your driver/generator, not the project (the #1 fuzzing
  FP). Triage question: harness or project? Answer with evidence.
- **Debug-only paths**: assertion/abort reachable only in debug builds; the release build
  handles it.
- **Container confinement**: the traversal/RCE works but is confined to an ephemeral
  sandbox with no secrets and no network — note as defense-in-depth gap, not a vuln.
- **Version mirage**: you're auditing a dependency version older/newer than what ships.

## Severity-inflation FPs

- **Self-DoS**: the "victim" and "attacker" are the same principal (crashing your own
  process with your own malformed file, no cross-principal impact).
- **Requires-the-keys-to-the-kingdom**: needs an existing admin/root — then it's not a
  privilege boundary crossing.
- **Theoretical race**: window exists but is not attacker-influenceable and has no
  security consequence (cosmetic state skew).
- **Infoleak of nothing**: OOB read returns bytes that never leave the process or contain
  no sensitive data on any path you can show.

## Reasoning FPs (model failure modes — self-check)

- **Assumed definition**: you guessed what a missing function/macro does. Fetch it. If
  you can't, the hypothesis stays unproven.
- **Contradictory path**: two walkthrough steps require mutually exclusive states.
- **Skipped conditional**: a branch on the path was waved through without attacker
  control demonstrated.
- **Echo-chamber promotion**: promoting because a previous agent/run said so. Independent
  verification only — pass@k runs must not see each other's notes.
- **Verifier gaming**: editing the verifier, weakening the signal regex, or asserting on
  your own log lines. Instant invalidation; log it as a process failure.

## Web-specific FPs

- **Reflected-but-sterile XSS**: payload reflects inside a context the browser can't
  execute (correctly-encoded attribute, JSON with the right content-type + nosniff).
  Confirm execution in a headless browser — reflection alone is not XSS.
- **Open-redirect dressing**: a redirect is not an auth bypass; state the real impact or
  demote.
- **CSRF on a state-unchanging endpoint.**
- **Rate-limit absence** reported as a vulnerability without a concrete abuse that
  violates a stated invariant.
