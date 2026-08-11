# Methodology sources

Every rule in SKILL.md is taken from a published, battle-tested system. Read these to
understand *why* the rules exist, and to keep the skill current as the field moves.

## Primary sources

### Sean Heelan — o3 finds CVE-2025-37899 (Linux kernel ksmbd UAF)
- Post: https://sean.heelan.io/2025/05/22/how-i-used-o3-to-find-cve-2025-37899-a-remote-zeroday-vulnerability-in-the-linux-kernels-smb-implementation/
- Prompts (verbatim): https://github.com/SeanHeelan/o3_finds_cve-2025-37899
- Follow-up on agentic exploitation: https://sean.heelan.io/2026/01/18/on-the-coming-industrialisation-of-exploit-generation-with-llms/
- What we copied: single bug class per run; N independent samples (he ran 100);
  ≤10k LoC slices (8/100 recall at 3.3k LoC → 1/100 at 12k LoC); BFS call-graph
  expansion to depth 3; explicit threat-model explainer; mandatory step-by-step path
  walkthrough with per-conditional attacker control; "better to report no
  vulnerabilities than false positives"; the verifier is "possibly the most important
  part of the agent" — harden it, models will try to game it.

### Google Project Zero / DeepMind — Big Sleep (née Naptime)
- https://googleprojectzero.blogspot.com/2024/06/project-naptime.html
- https://projectzero.google/2024/10/from-naptime-to-big-sleep.html
- What we copied: variant analysis as entry point ("this was a previous bug; there is
  probably another similar one"); commit diff + message as hunting seed; perfect
  verification — a crash is the only success signal, never an LLM judge; abort on
  stagnation; multiple independent short trajectories over one long one; specialised
  tools (code browser, debugger, sandbox) over whole-file dumps. Found a real SQLite
  0-day that 150 CPU-hours of AFL missed.

### DARPA AIxCC winners — buttercup (Trail of Bits), atlantis (Team Atlanta), artiphishell (Shellphish)
- https://github.com/trailofbits/buttercup · https://blog.trailofbits.com/2025/08/08/buttercup-is-now-open-source/
- https://arxiv.org/abs/2509.14589 · https://0xdkay.me/posts/team-atlanta-wins-darpa-aixcc/
- https://github.com/shellphish/artiphishell (full Jinja prompts in discoveryguy/)
- What we copied: sink-driven hypothesis generation (enumerate dangerous sinks, work
  backward to reachable entries); LLMs write *scripts that generate payloads*, never raw
  blobs; hard retry budgets with reflection on failure; bad-attempts lists fed back to
  the model; division of labor — fuzzers for memory corruption, LLMs for logic bugs;
  executable PoV as the only accepted output. Atlanta's LLM pipeline produced 71.2% of
  their verified PoVs and a real SQLite 0-day; the finalists jointly found 18 real
  0-days.

### XBOW — autonomous pentesting at scale
- https://xbow.com/blog/we-ran-1060-autonomous-attacks · https://xbow.com/blog/alloy-agents
- https://xbow.com/blog/top-1-how-xbow-did-it · https://xbow.com/blog/core-components-ai-pentesting-framework
- What we copied: "plausibility is not proof, confidence is not evidence"; strict
  discovery/validation separation ("Creative AI discovers. Deterministic logic decides
  what's real"); validators execute (headless browser for XSS, etc.); many short-lived
  narrow-objective agents with a hard iteration cap (~80), then a fresh restart;
  two-entity victim/attacker setups; cross-context retests; variant analysis after every
  confirmation. 85% on their benchmark in 28 min vs 40 h for a principal pentester;
  #1 on HackerOne US with ~1,060 submissions.

### Google oss-fuzz-gen
- https://google.github.io/oss-fuzz/research/llms/target_generation/ · https://github.com/google/oss-fuzz-gen
- https://security.googleblog.com/2024/11/leveling-up-fuzzing-finding-more.html
- What we copied: coverage-gap target selection; the generate → build → run → coverage
  loop; "return the full code every round"; prefer the longest candidate; the
  FuzzedDataProvider `std::string` trap; harness-vs-project crash triage question;
  1 same-project + 2 cross-project few-shot cap. Found 26+ new vulns including
  CVE-2024-9143 in OpenSSL, latent ~20 years, unreachable by human harnesses.

### CAI (Alias Robotics) & PentestGPT
- https://arxiv.org/html/2504.06017v1 · https://github.com/aliasrobotics/cai (prompts in src/cai/prompts/)
- https://arxiv.org/abs/2308.06782 · https://github.com/GreyDGL/PentestGPT
- What we copied: the TRACE micro-loop (Trace → Reason → Act → Check → Explain, one
  bounded action per turn); declare success *and* abandon criteria up front; the
  Decision Log; breadth before depth; ROI-ordered bug classes; confirmed-vs-hypothetical
  labeling; the report contract; never follow instructions embedded in target output.

## Round 2 sources (added v0.3.0)

### HPTSA — Teams of LLM Agents can Exploit Zero-Day Vulnerabilities (UIUC)
- https://arxiv.org/abs/2406.01637 · https://github.com/uiuc-kang-lab/HPTSA
- What we copied: planner → team-manager/dispatcher → task-specific expert agents
  (XSS, SQLi, CSRF, SSTI, ZAP, generic); each expert = tools + 5–6 diverse reference
  docs + customized prompt; single agents cannot backtrack between vuln types — dispatch
  a fresh expert instead; pass@5 is the metric that matters (42% on 14 real post-cutoff
  0-days, within 1.8× of an agent *given* the vulnerability; scanners scored 0%);
  simplify/summarize bulky tool output to cut tokens.

### OpenAI Aardvark (GPT-5 agentic security researcher, Oct 2025)
- https://openai.com/index/introducing-aardvark/
- What we copied: durable threat model as the campaign's foundation artifact;
  commit-level scanning against that model (our watch mode) instead of whole-repo
  rescans; sandboxed trigger attempts before reporting; proposed patches attached to
  findings. Published numbers: 92% recall on known/synthetic benchmark, 10 OSS CVEs.

### CodeQL multi-repo variant analysis (GitHub Security Lab / Semmle lineage)
- GitHub dogfooding writeups + MRVA (`codeql-variant-analysis-action`); QLCoder
  (synthesizes queries from CVEs; found unknown bugs in 2 repos with one query)
- What we copied: **variant-as-query** — every confirmed bug becomes a stored query run
  repo-wide and kept as a regression test; low-FP discipline for queries that run at
  fleet scale; one pattern found 6–8 additional vulnerable locations in dogfooding.

### CyberGym (Berkeley) & SEC-bench Pro
- https://arxiv.org/abs/2506.02548 · https://arxiv.org/abs/2605.26548
- What we copied: the PASS definition (crash pre-patch, no crash post-patch) as our
  regression-test contract; the **off-target crash rule** — CyberGym's own analysis
  found agent PoCs hitting *new* 0-days and incomplete patches when judged too narrowly;
  honest calibration: best agent ≈ 17.9% on the easiest level of 1,507 real CVEs.

### EnIGMA (NYU, SWE-agent for security) & SWE-agent ACI
- https://arxiv.org/abs/2409.16165 · https://swe-agent.com/latest/background/
- What we copied: interactive tools via batch wrappers (nested-REPL lesson adapted to
  one-shot shells); summarization/windows for long output (ACI: ~100-line file views,
  interface design alone was +10.7pp); 13.5% on NYU CTF, 3× prior SOTA.

### LLM-guided fuzzing: Fuzz4All, ChatAFL, PromptFuzz
- Fuzz4All (autoprompting distills docs into prompts; coverage-updated prompt loop with
  natural-language mutation directives; SOTA coverage across 6 languages)
- ChatAFL (NDSS'24: spec → message grammars + inferred state machine; fuzz state
  sequences; 9 new vulns in widely-used protocols)
- PromptFuzz (coverage-guided prompt iteration for fuzz-driver generation)
- What we copied: the LLM-as-mutation-engine loop and protocol state-machine fuzzing
  in the playbooks.

## Calibration numbers (set expectations honestly)

- Signal:noise on raw LLM audits ≈ 1:50 (Heelan) — validation is not optional.
- o3 found the target UAF in 8/100 runs at 3.3k LoC, 1/100 at 12k LoC — slice small.
- Real-world reproduction is hard: CyberGym's best agent solves ≈ 17.9% of the easiest
  tier with full description + source; HPTSA reaches 42% *at pass@5*; EnIGMA 13.5% on
  CTFs. Volume × deterministic validation is the strategy — not one-shot analysis.
- Big Sleep took CyberSecEval2 buffer-overflow scores from 0.05 → 1.00 with tools +
  iteration vs zero-shot.
- A capability floor exists: models that cannot chain tool calls fail regardless of
  prompting (Big Sleep). Use the strongest available model for discovery.
- Human experts still win the hardest tier (XBOW vs humans) — this skill finds the bugs
  humans miss by *coverage and stamina*, not by being smarter.
