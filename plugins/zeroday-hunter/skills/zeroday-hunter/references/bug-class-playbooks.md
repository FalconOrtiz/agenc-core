# Bug-class playbooks

One campaign = one bug class. Each playbook: sinks → path-feasibility checks → walkthrough
questions → PoC strategy → signal for the verifier → classic false positives. Extend the
sink tables from the target's own code before scoring.

---

## 1. Use-after-free / double free (C/C++)

- **Sinks**: `free`, `delete`, `g_free`, refcount `put/dec`, pool/arena release,
  `close`/`fclose`, destructors, `RCU` frees in kernel code.
- **Path checks**: who owns the object at each point; every error path between allocation
  and sink; is the pointer NULL-ed after free; is teardown shared across sessions/threads;
  can the attacker trigger the error path *and* the later reuse.
- **Walkthrough questions**: after the free, name every path that dereferences the
  pointer and how the attacker reaches it; can two attacker-controlled connections share
  the object (concurrency as the trigger); is there a destructor/callback that re-enters.
- **PoC strategy**: trigger the free, then spray reallocations with attacker-controlled
  bytes to reclaim the slot, then trigger the use. ASan build: the UAF itself is the
  signal — you often don't need the spray to *confirm* (note that in the report honestly).
- **Verifier signal**: `ERROR: AddressSanitizer: heap-use-after-free|double-free`.
- **FP traps**: freed memory that is provably never referenced again (log-and-return
  paths); pool allocators where "free" is a no-op; objects immortal by design.

## 2. OOB read/write, off-by-one (C/C++)

- **Sinks**: `memcpy`/`memmove`/`strncpy`, `sprintf`/`snprintf` (check the n!), loop
  writes indexed by attacker values, `read`/`recv` into fixed buffers, pointer arithmetic
  on wire lengths.
- **Path checks**: length validated against *destination* capacity, not source length;
  signed→unsigned conversion before comparison; `len * size` overflow before allocation;
  terminator handling in "safe" string APIs (strncpy doesn't NUL-terminate on truncation).
- **PoC strategy**: boundary values — exactly capacity, capacity±1, 0, INT_MAX,
  negative-as-unsigned. Generator script computes length fields so mutations stay valid.
- **Verifier signal**: ASan `heap-buffer-overflow` / `stack-buffer-overflow` /
  `global-buffer-overflow`.
- **FP traps**: flexible array members misread as overflows; `snprintf` patterns that are
  actually bounded; reads past end that stay inside a legitimately larger allocation
  (still a bug if data crosses a trust boundary — report as infoleak only if bytes return
  to the attacker).

## 3. Integer overflow / truncation

- **Sinks**: allocations, size/index arithmetic, casts `int ↔ size_t ↔ uint16_t`,
  wire length fields used in arithmetic.
- **Path checks**: every arithmetic op between attacker value and its use as size/index;
  comparisons done in a *different* width than the use.
- **PoC strategy**: values straddling width boundaries: 2^8/16/31/32 ± 1.
- **Verifier signal**: UBSan `unsigned-integer-overflow` is *not* a bug by itself — you
  need the downstream effect (small alloc + large copy). Signal on the ASan report of the
  consequence, or on an assertion you add to a debug build.

## 4. SQL injection

- **Sinks**: string-concatenated query builders, ORM raw/escape hatches (`raw()`,
  `extra()`, `execute($sql)`), `ORDER BY`/identifier interpolation (parameter binding
  can't help there — classic miss).
- **Path checks**: any byte of the query string attacker-influenced; encoding layers
  between input and query (double-decode bypasses); second-order flows (stored value
  used in a later query).
- **PoC strategy**: start with an *oracle*, not exfiltration: boolean (`' AND '1'='1`),
  time-based (`SLEEP`) — pick per backend. Prove data difference or measurable delay.
- **Verifier signal**: deterministic response diff (row count, status, content marker) or
  delay ≥ threshold measured by the script, both reproduced ≥ 3 runs.
- **FP traps**: frameworks that auto-escape (verify by sending a quote and reading the
  *actual* query in logs); concatenated-but-constant fragments.

## 5. Command injection

- **Sinks**: `exec`/`system`/`popen`/`shell=True`/`ProcessBuilder` with a shell string;
  argument arrays are safer — check whether any element embeds unescaped input anyway.
- **Path checks**: metacharacter survival (`; & | $() \` \n`); PATH/env control;
  quoting that *looks* right but breaks on newline or `$(...)`.
- **PoC strategy**: out-of-band canary — write a file, touch a URL you observe, sleep.
  Never destructive.
- **Verifier signal**: canary file/content appears.
- **FP traps**: input confined to a fixed whitelist validated immediately before the sink.

## 6. Path traversal / arbitrary file access

- **Sinks**: `open`/`readFile`/`sendFile`/include/require, archive extraction, symlink
  following, file upload destinations.
- **Path checks**: canonicalization *after* URL/percent decoding; prefix check against the
  fully resolved path (`/srv/files/../x` resolves out); `..` encoded (`%2e%2e`, `..;/`,
  unicode); symlinks inside the allowed root pointing out.
- **PoC strategy**: read a known file outside root (`/etc/passwd` or a planted canary).
- **Verifier signal**: canary content in response.
- **FP traps**: chroot/container confinement that genuinely neutralizes it (note it as
  defense-in-depth, not a vuln).

## 7. AuthN/AuthZ / IDOR (logic — reasoning only)

- **Sinks**: every handler that takes an object id; middleware chains; role checks.
- **Method**: enumerate object references; for each, find the ownership check — its
  *absence* is the bug. Two-entity setup: create victim + attacker, replay victim's
  requests with attacker's session. **Cross-context retests**: no session, wrong role,
  expired token, different HTTP method, `id` in body vs path vs JWT.
- **PoC strategy**: attacker reads/writes one victim object. Deterministic and minimal.
- **Verifier signal**: 200 + victim's data (or mutation persisted) with attacker's
  credentials; control run with victim's session must also pass, and without any session
  must fail — all three scripted.
- **FP traps**: ids that are unguessable *and* treated as capability tokens by design
  (documented behavior — report only if the design leaks ids); checks enforced at a layer
  you didn't see (verify at the datastore boundary, not the controller).

## 8. Race conditions / TOCTOU

- **Sinks**: check-then-act on files (`access`→`open`), rows (SELECT→UPDATE without
  transaction/lock), balances/limits/counters; shared mutable state; signal handlers.
- **Path checks**: is the check and the use inside the same lock/transaction; can the
  attacker fire N concurrent requests (connection pooling, HTTP/2 multiplexing,
  last-byte-sync to align arrivals).
- **PoC strategy**: N parallel clients with synchronized release; success = invariant
  broken (double spend, limit exceeded, stale read used).
- **Verifier signal**: final state violates the invariant, reproduced at rate > baseline
  over M runs (report the rate honestly).
- **FP traps**: races with no security consequence; single-threaded-by-design runtimes
  (verify the deployment model first).

## 9. Deserialization

- **Sinks**: `pickle`/`yaml.load`/`ObjectInputStream`/`unserialize`/JSON into polymorphic
  types; also "safe" formats with type annotations.
- **Path checks**: does the input cross a trust boundary unsigned/unencrypted; which
  gadget classes are on the classpath/module path.
- **PoC strategy**: start with a detection gadget (DNS/HTTP callback, sleep), not RCE.
- **Verifier signal**: callback observed.
- **FP traps**: inputs that are HMAC-verified before parse.

## 10. Business logic

- **Method**: extract invariants from docs/tests/pricing rules ("balance ≥ 0", "one
  coupon per order", "states advance monotonically"); then find call sequences of
  *legitimate* operations that break them: replay, reorder, skip, duplicate (idempotency
  keys missing), negative amounts, currency rounding.
- **Verifier signal**: invariant violation observable in state (balance, order count).
- **FP traps**: "by design" behaviors — confirm against docs before promoting.

---

## Fuzz-harness rules (memory-unsafe targets)

1. Target selection by coverage gap: far-reaching, low-coverage functions first.
2. The harness must actually call the function-under-test — verify, or you're
   manufacturing false negatives.
3. `FuzzedDataProvider`: avoid `std::string`-returning methods unless the API needs a
   string — they hide off-by-ones from ASan. No `rand()`; all bytes from the fuzzer.
   No NULL params unless the API allows them. Declare variables before `goto`.
4. Build loop: return the **full** harness every fix round; prefer the most complete
   candidate; never delete code to make it compile.
5. Crash triage question: **bug in harness or bug in project?** — True/False with
   evidence before proceeding. Harness bugs are FP source #1. And an **off-target crash
   (different bug than the one hunted) is still a finding** — triage it, never discard it.
6. Few-shot cap: 1 same-project + 2 cross-project examples; more degrades results.
7. 150 CPU-hours of silence ≠ safe code; it means the harness doesn't reach the path.
   Mutate the input *shape* (structure-aware generators), not the budget.

## The LLM-guided fuzzing loop (you are the mutation engine)

When classical fuzzing saturates, take over the mutation loop yourself (Fuzz4All-style):

1. **Autoprompt**: distill the input format (docs, parser code, examples) into a compact
   spec prompt before generating anything.
2. Generate N diverse seeds; run them; collect coverage.
3. Feed the coverage summary back: "regions X, Y uncovered; feature Z untouched" →
   generate mutations **aimed at named uncovered regions** ("mutate this input to reach
   the gzip path"), not random tweaks.
4. Track coverage-per-attempt; when it plateaus, change the input *shape* (different
   feature combination, deeper nesting, different state sequence), never the budget.
5. **Protocol targets (ChatAFL-style)**: first convert the spec/RFC into a message
   grammar + inferred state machine (states, transitions, expected responses). Fuzz
   *state sequences*, not just message bytes — interleaved/out-of-order messages are
   where the bugs are. Use server responses to correct your state machine inference.
6. Validate every crash through the harness-vs-project triage question, then minimize
   before writing the hypothesis record.
