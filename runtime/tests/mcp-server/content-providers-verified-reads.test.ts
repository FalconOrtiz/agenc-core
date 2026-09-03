/**
 * Regression tests for issue #1794: MCP content providers must serve
 * skill prompts and resource bodies through one descriptor-bound reader.
 * A writable workspace cannot swap the candidate file or an ancestor
 * between validation and bytes: every swap lands on a hook at a real
 * filesystem I/O boundary, and each scenario must end with the candidate
 * omitted (prompts) or unreadable (resources) — never with swapped bytes.
 */
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { enterCanonicalSettingsAuthority } from "../../src/utils/settings/canonicalAuthority.js";

import {
  MAX_SCOPED_FILE_BYTES,
  createMemoryResourceProvider,
  createSkillPromptProvider,
} from "../../src/mcp/server/content-providers.js";

const SECRET = "PRIVATE SESSION TRANSCRIPT ak_1794_secret";
const SECRET_TOKEN = "ghp_1794567890abcdefABCDEF1234567890abcdef";

const roots: string[] = [];
let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "agenc-mcp-verified-"));
  roots.push(root);
  vi.stubEnv("AGENC_HOME", root);
  enterCanonicalSettingsAuthority(new ConfigStore({
    home: root,
    env: { ...process.env, AGENC_HOME: root },
    cwd: root,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of roots.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeSkill(name: string, body: string): string {
  const dir = join(root, "skills", name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(
    file,
    ["---", `description: ${name} skill`, "---", body].join("\n"),
  );
  return file;
}

function makeOutsideSecret(name: string): string {
  const outside = mkdtempSync(join(tmpdir(), "agenc-mcp-outside-"));
  roots.push(outside);
  const file = join(outside, name);
  writeFileSync(
    file,
    ["---", `description: ${name}`, "---", SECRET, SECRET_TOKEN].join("\n"),
  );
  return file;
}

function makeMemoryFile(name: string, body: string): string {
  mkdirSync(join(root, "memory"), { recursive: true });
  const file = join(root, "memory", name);
  writeFileSync(
    file,
    ["---", `name: ${name.replace(/\.md$/, "")}`, `description: ${name}`, "---", body].join("\n"),
  );
  return file;
}

function skillProvider(
  hooks: {
    beforeOpenForTesting?: (path: string) => void;
    beforeReadForTesting?: (path: string) => void;
  } = {},
) {
  return createSkillPromptProvider({
    skillRoots: [join(root, "skills")],
    scopeRoot: root,
    ...hooks,
  });
}

function resourceProvider(
  hooks: {
    beforeOpenForTesting?: (path: string) => void;
    beforeReadForTesting?: (path: string) => void;
  } = {},
) {
  return createMemoryResourceProvider({
    memoryDirs: [join(root, "memory")],
    scopeRoot: root,
    ...hooks,
  });
}

describe("verified skill prompt reads", () => {
  test("serves a plain in-scope skill", async () => {
    makeSkill("plain", "safe body");
    const provider = skillProvider();
    const prompts = await provider.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("plain");
    const prompt = await provider.getPrompt("plain");
    expect(prompt?.messages[0]).toMatchObject({
      role: "user",
      content: { type: "text", text: expect.stringContaining("safe body") },
    });
  });

  test("omits a skill swapped for a symlink after validation", async () => {
    const file = makeSkill("swapped", "safe body");
    const secret = makeOutsideSecret("secret.md");
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        rmSync(file);
        symlinkSync(secret, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
    expect(await provider.getPrompt("swapped")).toBeNull();
  });

  test("omits a skill swapped for a symlink to the same inode after validation", async () => {
    const file = makeSkill("selflink", "safe body");
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        // The replacement symlink resolves to the very inode validation
        // saw; only the O_NOFOLLOW open rejects it.
        const alias = `${file}.same-inode`;
        linkSync(file, alias);
        rmSync(file);
        symlinkSync(alias, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits a skill replaced by another regular file after validation", async () => {
    const file = makeSkill("replaced", "safe body");
    const attacker = join(root, "attacker.md");
    writeFileSync(attacker, "attacker body", "utf8");
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        renameSync(attacker, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits a skill whose ancestor directory is swapped for a symlink after validation", async () => {
    const file = makeSkill("ancestor", "safe body");
    const outsideDir = mkdtempSync(join(tmpdir(), "agenc-mcp-outside-"));
    roots.push(outsideDir);
    writeFileSync(
      join(outsideDir, "SKILL.md"),
      ["---", "description: forged", "---", SECRET].join("\n"),
    );
    const provider = skillProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        const dir = join(root, "skills", "ancestor");
        renameSync(dir, `${dir}.moved`);
        symlinkSync(outsideDir, dir);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
    expect(await provider.getPrompt("ancestor")).toBeNull();
  });

  test("omits a skill whose open file is replaced before the read", async () => {
    const file = makeSkill("midread", "safe body");
    const attacker = join(root, "midread-attacker.md");
    writeFileSync(attacker, "attacker body", "utf8");
    const provider = skillProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        renameSync(attacker, file);
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits a skill mutated in place after the open", async () => {
    const file = makeSkill("mutated", "safe body");
    const provider = skillProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        writeFileSync(file, "mutated body!", "utf8");
      },
    });
    expect(await provider.listPrompts()).toEqual([]);
  });

  test("omits multiply linked skill files", async () => {
    const secret = makeOutsideSecret("session.md");
    const dir = join(root, "skills", "leak");
    mkdirSync(dir, { recursive: true });
    linkSync(secret, join(dir, "SKILL.md"));
    const provider = skillProvider();
    expect(await provider.listPrompts()).toEqual([]);
    expect(await provider.getPrompt("leak")).toBeNull();
  });

  test("omits oversized skill files", async () => {
    const dir = join(root, "skills", "huge");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      Buffer.alloc(MAX_SCOPED_FILE_BYTES + 1, 0x61),
    );
    const provider = skillProvider();
    expect(await provider.listPrompts()).toEqual([]);
  });

  test.runIf(process.platform !== "win32")(
    "omits a skill replaced by a FIFO after validation without blocking",
    async () => {
      const file = makeSkill("fifod", "safe body");
      const provider = skillProvider({
        beforeOpenForTesting: (path) => {
          if (path !== file) return;
          rmSync(file);
          expect(spawnSync("mkfifo", [file]).status).toBe(0);
        },
      });
      expect(await provider.listPrompts()).toEqual([]);
    },
  );
});

describe("verified memory resource reads", () => {
  test("reads an in-scope memory file with secrets redacted", async () => {
    makeMemoryFile("notes.md", `plain body ${SECRET_TOKEN}`);
    const provider = resourceProvider();
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).toContain("notes.md");
    const uri = resources.find((r) => r.name === "notes.md")!.uri;
    const read = await provider.readResource(uri);
    expect(read?.contents[0]).toMatchObject({ mimeType: "text/markdown" });
    expect(read?.contents[0].text).toContain("plain body");
    expect(read?.contents[0].text).not.toContain(SECRET_TOKEN);
  });

  test("does not read resource bodies while listing", async () => {
    makeMemoryFile("notes.md", "plain body");
    let reads = 0;
    const provider = resourceProvider({
      beforeReadForTesting: () => {
        reads += 1;
      },
    });
    const resources = await provider.listResources();
    expect(reads).toBe(0);
    const uri = resources.find((r) => r.name === "notes.md")!.uri;
    await provider.readResource(uri);
    expect(reads).toBe(1);
  });

  test("does not list multiply linked memory files", async () => {
    const file = makeMemoryFile("leak.md", SECRET);
    const outsideDir = mkdtempSync(join(tmpdir(), "agenc-mcp-outside-"));
    roots.push(outsideDir);
    // The memory file now also answers to a name outside the scope root.
    linkSync(file, join(outsideDir, "alias.md"));
    const provider = resourceProvider();
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).not.toContain("leak.md");
  });

  test("does not list oversized memory files", async () => {
    mkdirSync(join(root, "memory"), { recursive: true });
    writeFileSync(
      join(root, "memory", "huge.md"),
      Buffer.alloc(MAX_SCOPED_FILE_BYTES + 1, 0x61),
    );
    const provider = resourceProvider();
    const resources = await provider.listResources();
    expect(resources.map((r) => r.name)).not.toContain("huge.md");
  });

  test("fails a resource read when the file is swapped for a symlink after validation", async () => {
    makeMemoryFile("notes.md", "plain body");
    const provider = resourceProvider();
    const resources = await provider.listResources();
    const target = resources.find((r) => r.name === "notes.md")!;
    const file = join(root, "memory", "notes.md");
    const secret = makeOutsideSecret("secret.md");
    const swapped = resourceProvider({
      beforeOpenForTesting: (path) => {
        if (path !== file) return;
        rmSync(file);
        symlinkSync(secret, file);
      },
    });
    expect(await swapped.readResource(target.uri)).toBeNull();
  });

  test("fails a resource read when the open file is replaced before the read", async () => {
    makeMemoryFile("notes.md", "plain body");
    const provider = resourceProvider();
    const resources = await provider.listResources();
    const target = resources.find((r) => r.name === "notes.md")!;
    const file = join(root, "memory", "notes.md");
    const attacker = join(root, "attacker.md");
    writeFileSync(attacker, "attacker body", "utf8");
    const swapped = resourceProvider({
      beforeReadForTesting: (path) => {
        if (path !== file) return;
        renameSync(attacker, file);
      },
    });
    expect(await swapped.readResource(target.uri)).toBeNull();
  });

  test.runIf(process.platform !== "win32")(
    "fails a resource read when the file is replaced by a FIFO after validation without blocking",
    async () => {
      makeMemoryFile("notes.md", "plain body");
      const provider = resourceProvider();
      const resources = await provider.listResources();
      const target = resources.find((r) => r.name === "notes.md")!;
      const file = join(root, "memory", "notes.md");
      const swapped = resourceProvider({
        beforeOpenForTesting: (path) => {
          if (path !== file) return;
          rmSync(file);
          expect(spawnSync("mkfifo", [file]).status).toBe(0);
        },
      });
      expect(await swapped.readResource(target.uri)).toBeNull();
    },
  );
});
