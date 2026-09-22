import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, test } from "vitest";
import { createPluginFromPath } from "../../../src/plugins/loader.js";
import { canonicalMcpServerToServiceConfig } from "../../../src/services/mcp/user-config-toml.js";
import { toScopedMcpServerConfig } from "../../../src/mcp-client/manager.js";
import { toToolCatalogPolicyConfig } from "../../../src/mcp-client/resilient-client.js";
import { createToolBridge } from "../../../src/mcp-client/tools.js";
import type { McpServerConfig } from "../../../src/config/schema.js";
import declarations from "./fixtures/staged-plugin-mcp-contracts.js";

// Exact MCP and user-config declarations from the nine staged plugin manifests.
// No provider is contacted, installed, enabled, or authenticated by this test.
const manifests = declarations as Array<{ name: string; mcpServers: Record<string, McpServerConfig>; userConfig?: unknown }>;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "agenc-staged-mcp-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

for (const manifest of manifests) {
  test(`${manifest.name} declaration preserves disabled state, OAuth and read-tool policy`, async () => {
    const directory = join(root, manifest.name);
    await mkdir(join(directory, ".agenc-plugin"), { recursive: true });
    await writeFile(join(directory, ".agenc-plugin", "plugin.json"), JSON.stringify(manifest));
    const result = await createPluginFromPath(directory, { source: manifest.name, enabled: true });
    expect(result.errors).toEqual([]);
    const config = result.plugin!.mcpServers[manifest.name]!;
    expect(config.enabled).toBe(false);
    expect(config.oauth).toEqual(manifest.mcpServers[manifest.name]!.oauth);
    expect(config.default_tools_approval_mode).toBe("on-request");
    expect(canonicalMcpServerToServiceConfig(config)).toMatchObject({ enabled: false });
    const scoped = toScopedMcpServerConfig({ ...config, name: `plugin:${manifest.name}:${manifest.name}` });
    if ("oauth" in scoped) expect(scoped.oauth).toEqual(config.oauth);
    const allowed = config.enabled_tools;
    if (manifest.name === "linear") {
      expect(config.endpoint).toBe("https://mcp.linear.app/mcp/readonly");
      expect(config.oauth?.scopes).toEqual(["read"]);
      return;
    }
    expect(allowed?.length).toBeGreaterThan(0);
    const bridge = await createToolBridge({
      listTools: async () => ({ tools: [...allowed!, "fixture_write_all"].map((name) => ({ name, inputSchema: { type: "object", properties: {} } })) }),
      close: async () => {},
    }, manifest.name, undefined, { environment: {}, serverConfig: toToolCatalogPolicyConfig({ ...config, name: manifest.name }) });
    expect(bridge.tools).toHaveLength(allowed!.length);
    expect(bridge.tools.some((tool) => tool.name.includes("fixture_write_all"))).toBe(false);
    await bridge.dispose();
  });
}
