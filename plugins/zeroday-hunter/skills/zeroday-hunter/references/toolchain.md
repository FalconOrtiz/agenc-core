# Toolchain recipes

Concrete commands for each campaign task. Detect before use (`which <tool>`); install
only into isolated environments; never modify the system outside the worktree.

## Slicing & navigation

```bash
# call-graph slice around an entry symbol (heuristic, budget-capped)
scripts/zdh-slice.sh <repo> <symbol> [depth=3] [max-lines=10000]

# callers of a function (fast, approximate)
grep -rn "\b<symbol>\s*(" --include='*.c' --include='*.h' <repo> | grep -v '^\s*\*'

# universal-ctags index for accurate definition lookup
ctags -R --fields=+n -f .zdh/tags <repo>

# tree-sitter / joern / codeql when available — prefer them over grep on big targets
joern --script slice.sc --param symbol=<symbol>      # precise CPG slicing
codeql database analyze db cpp-security-and-quality.qls
```

## Builds with sanitizers (memory targets)

```bash
# C/C++ autotools/cmake
CFLAGS="-g -O1 -fsanitize=address,undefined -fno-omit-frame-pointer" \
CXXFLAGS="$CFLAGS" LDFLAGS="-fsanitize=address,undefined" ./configure && make -j
cmake -B build -DCMAKE_C_FLAGS="-g -O1 -fsanitize=address,undefined" && cmake --build build

# keep a clean release build too — some FPs only exist in debug/sanitized builds;
# confirm reachability on the release build before reporting
```

ASan options worth setting at runtime:
`ASAN_OPTIONS=abort_on_error=1:symbolize=1:detect_leaks=0` (leaks are not vulns here).
UBSan unsigned-overflow is *not* a finding by itself — chase the downstream effect.

## Fuzzing

```bash
# libFuzzer harness cycle (see playbooks for harness rules)
clang -g -O1 -fsanitize=address,fuzzer harness.c target.c -o fuzz-target
./fuzz-target corpus/ -max_total_time=300 -print_final_stats=1

# AFL++ for existing binaries
afl-fuzz -i seeds/ -o out/ -- ./target @@

# coverage: which lines did we actually reach
llvm-cov show ./fuzz-target -instr-profile=default.profdata | grep -E '^\s+[0-9]+\|' | wc -l
```

Crash handling: `zdh-triage.sh <crash-dir>` dedups by (sanitizer signal, top frame);
minimize with `afl-tmin` / `-minimize_crash=1` *before* writing the hypothesis record.

## Web/service targets

```bash
# run the real service locally, real config; seed victim + attacker fixtures
# oracle-first probing: boolean diffs and timing, scripted — never eyeballed
curl -s -o /dev/null -w '%{http_code} %{size_download} %{time_total}\n' ...

# headless confirmation for JS execution (XSS rung)
node -e "/* puppeteer: visit URL, hook console/dialog, assert marker fired */"
```

## Debugging & dynamic tracing

Interactive REPL tools (gdb, netcat, radare2) are essential but this environment runs
one-shot commands — use **batch wrappers** so every session is scriptable and its output
capturable for the evidence log (EnIGMA's lesson: interactive access matters; make it
non-interactive yourself):

```bash
gdb -batch -ex run -ex bt -ex 'info registers rip' --args ./target poc.bin
rr record ./target poc.bin && rr replay    # reverse-debug the corruption origin
uftrace record ./target poc.bin            # function-level trace for path proof
printf 'GET / HTTP/1.0\r\n\r\n' | timeout 5 nc target 80    # scripted netcat
python3 -c 'import socket; ...'            # when you need real protocol control
```

Output discipline: pipe long output to a file, then read it in ~100-line windows
(`sed -n '1,100p'`); whole-file dumps destroy focus — retrieve, don't dump.

## Payload generators

- Python 3 stdlib is usually enough: `struct.pack` for length fields, `zlib.crc32`,
  `zipfile`/`xml` for nested formats.
- Every generator takes `--seed`/`--mutate` knobs so failure-class-driven mutation is a
  flag, not a rewrite.
- Never paste blobs into source; generate them.

## Isolation rules

- All builds, PoCs, crashes, and corpuses live under `.zdh/<campaign-id>/` or the
  campaign worktree — never in the target repo's tree (keeps `git status` clean and the
  baseline diff honest).
- Network access only where the sandbox policy allows it; callback servers for
  SSRF/deserialization detection bind localhost unless the user approves otherwise.
