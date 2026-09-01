import { describe, expect, it } from "vitest";

import { classifyShellWorkspaceWritePolicy } from "../../src/llm/shell-write-policy.js";

const WORKSPACE_ROOT = "/repo";

function classify(command: string) {
  return classifyShellWorkspaceWritePolicy({
    toolName: "exec_command",
    args: { command },
    workspaceRoot: WORKSPACE_ROOT,
  });
}

describe("classifyShellWorkspaceWritePolicy", () => {
  it("does not read the fd prefix of 2>/dev/null as an rmdir operand", () => {
    const decision = classify("rmdir tmp 2>/dev/null");

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.blockedTargets).toEqual([]);
  });

  it("allows the cleanup chain that was rejected five times in a row", () => {
    const decision = classify(
      "rm -f tmp/snake-sim.js && rmdir tmp 2>/dev/null; ls -la game5 game4b; node --check game5/game.js",
    );

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
  });

  it("ignores program text inside a stdin heredoc", () => {
    const decision = classify(
      [
        "node --check game5/game.js && node <<'JS'",
        "const s = { x: 0 };",
        "const r = { pass: false };",
        "if (s.x === 0 && !r.pass) { console.log(1 > 0); }",
        "JS",
      ].join("\n"),
    );

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.observedTargets).toEqual([]);
  });

  it("allows a heredoc redirected outside the workspace", () => {
    const decision = classify(
      ["cat > /tmp/game4b_sim.js << 'EOF'", "if (b.x > 40) { x = 1; }", "EOF"].join(
        "\n",
      ),
    );

    expect(decision.blocked).toBe(false);
    expect(decision.indeterminate).toBe(false);
    expect(decision.observedTargets).toEqual(["/tmp/game4b_sim.js"]);
  });

  it("still blocks a heredoc redirected into a workspace source file", () => {
    const decision = classify(
      ["cat > src/x.js <<EOF", "export const x = 1 > 0;", "EOF"].join("\n"),
    );

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/repo/src/x.js"]);
  });

  it("still blocks an fd-prefixed redirect into a workspace file", () => {
    const decision = classify("make 2> build/make.log 2>> src/errors.log");

    expect(decision.blocked).toBe(true);
    expect(decision.blockedTargets).toEqual(["/repo/src/errors.log"]);
  });

  it("treats 2>&1 as a descriptor duplication, not a file", () => {
    const decision = classify("npm test 2>&1 | tail -20");

    expect(decision.blocked).toBe(false);
    expect(decision.observedTargets).toEqual([]);
  });

  it("denies with one sentence plus the blocked targets", () => {
    const decision = classify("echo hi > notes.txt");

    expect(decision.blocked).toBe(true);
    expect(decision.message).toBe(
      "shell_workspace_file_write_disallowed: shell commands may not write " +
        "workspace files except under build, dist, logs, .cache, tmp, or coverage; " +
        "use Edit or Write instead. Blocked target(s): /repo/notes.txt",
    );
  });
});
