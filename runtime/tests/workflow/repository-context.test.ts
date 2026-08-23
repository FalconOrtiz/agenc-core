import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildRepositoryContextPack } from "../../src/app-server/workflow/repository-context.js";

const temporaryDirectories: string[] = [];

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agenc-repository-context-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("buildRepositoryContextPack", () => {
  it("surfaces bounded source and test excerpts from goal identifiers", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "src/hardware/backends"), { recursive: true });
    await mkdir(path.join(root, "tests"), { recursive: true });
    await mkdir(path.join(root, "docs"), { recursive: true });
    await writeFile(
      path.join(root, "src/hardware/backends/rocm-detector.js"),
      [
        "const AMD_DEVICE_IDS = {};",
        "function resolveGpuMemoryProfile(name) {",
        "  return name.includes('AMD') ? 'integrated unified memory' : 'dedicated';",
        "}",
      ].join("\n"),
    );
    await writeFile(
      path.join(root, "tests/amd-gpu-detection.test.js"),
      "test('hw-detect AMD GPU classification', () => expect('memory').toBeTruthy());\n",
    );
    await writeFile(
      path.join(root, "docs/unrelated.md"),
      "Generic project documentation with no accelerator details.\n",
    );

    const pack = await buildRepositoryContextPack(
      root,
      "Fix AMD Strix Halo unified-memory hardware detection for Radeon 8060S device ID 1586; hw-detect must report integrated memory.",
    );

    expect(pack).toBeDefined();
    expect(pack!.matchedFiles).toContain("src/hardware/backends/rocm-detector.js");
    expect(pack!.matchedFiles).toContain("tests/amd-gpu-detection.test.js");
    expect(pack!.text).toContain("<BEGIN_UNTRUSTED_REPOSITORY_CONTEXT>");
    expect(pack!.text).toContain("resolveGpuMemoryProfile");
    expect(pack!.text.length).toBeLessThanOrEqual(18_000);
  });

  it("skips ignored directories and symbolic links", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "node_modules/decoy"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(
      path.join(root, "node_modules/decoy/strix.js"),
      "Radeon 8060S Strix Halo 1586\n",
    );
    await writeFile(path.join(root, "outside.js"), "Radeon 8060S Strix Halo 1586\n");
    await symlink(path.join(root, "outside.js"), path.join(root, "src/linked.js"));
    await writeFile(path.join(root, "src/amd.js"), "AMD integrated unified memory\n");

    const pack = await buildRepositoryContextPack(
      root,
      "AMD Strix Halo Radeon 8060S 1586 integrated unified memory",
    );

    expect(pack).toBeDefined();
    expect(pack!.matchedFiles).not.toContain("node_modules/decoy/strix.js");
    expect(pack!.matchedFiles).not.toContain("src/linked.js");
    expect(pack!.matchedFiles).toContain("src/amd.js");
  });

  it("is deterministic for an unchanged repository", async () => {
    const root = await fixtureRoot();
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src/b.ts"), "export const deviceId = '1586';\n");
    await writeFile(path.join(root, "src/a.ts"), "export const family = 'Strix Halo';\n");
    const goal = "Detect AMD Strix Halo device ID 1586";

    const first = await buildRepositoryContextPack(root, goal);
    const second = await buildRepositoryContextPack(root, goal);

    expect(second).toEqual(first);
  });
});
