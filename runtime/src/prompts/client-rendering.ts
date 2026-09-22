import type { ProviderEnvironment } from "../llm/provider-options.js";

/** Versioned renderer capability, not authorization to execute model output. */
export const DESKTOP_RICH_RENDERER_CLIENT = "agenc-desktop-rich-v1";

const DESKTOP_RENDERING_SECTION = [
  "# Desktop response formatting",
  "This session's client is AgenC Desktop with a rich chat renderer, not a monospace-only terminal. These are presentation capabilities only; they do not change tool permissions or authorize code execution.",
  "Use a visual only when it materially helps explain the answer. Prefer concise prose otherwise. Never invent measurements, source data or model results to fill a chart. Label illustrative data as illustrative.",
  "Math: use $$...$$ or \\[...\\] for display equations, $...$ or \\(...\\) for inline math, or a fenced math, latex or tex block. The client renders a bounded LaTeX subset; unsupported commands remain readable source.",
  "Charts: use a fenced chart block containing JSON, not JavaScript. Schema: {\"type\":\"line\"|\"bar\"|\"scatter\",\"title\"?:string,\"xLabel\"?:string,\"yLabel\"?:string,\"labels\"?:string[],\"series\":[{\"name\":string,\"data\":number[]|{\"x\":number,\"y\":number,\"label\"?:string}[]}]}. Bar charts require numeric arrays; scatter charts require x/y objects; line charts support either. All series use the same format. Category arrays must have equal lengths matching labels; omit top-level labels for x/y data. Series names are unique; text fields contain 1 to 80 characters. Supply finite numbers between -1e15 and 1e15. Limit each chart to 8 series, 200 total points and 10,000 source characters. Example: {\"type\":\"line\",\"labels\":[\"A\",\"B\"],\"series\":[{\"name\":\"Illustrative\",\"data\":[1,2]}]}.",
  "Flow diagrams: use a fenced mermaid block starting with flowchart or graph and direction TD, TB, LR, BT or RL. Supported node forms are A[Label], B(Rounded label) and C{Decision}; connect IDs with -->, ---, -.-> or ==> and optional |edge label|. Chained connections work. Put each statement on its own line or separate statements with semicolons. Quote labels containing brackets. No subgraphs, styling directives, clickable links or other Mermaid diagram types are rendered.",
  "Declarative models: alternatively use a fenced diagram or model block containing JSON: {\"title\"?:string,\"direction\"?:\"TD\"|\"TB\"|\"LR\"|\"BT\"|\"RL\",\"nodes\":[{\"id\":string,\"label\"?:string,\"shape\"?:\"rectangle\"|\"rounded\"|\"diamond\"}],\"edges\":[{\"from\":string,\"to\":string,\"label\"?:string}]}. IDs start with a letter or underscore and contain only letters, digits, underscores or dashes (maximum 64 characters); every edge must reference a declared node. These are 2D node-and-connection models, not interactive 3D models.",
  "Diagram limits: 32 nodes, 64 edges and 16,000 source characters; node labels at most 180 characters, edge labels 80 and titles 120. Labels are plain text. Close every fence. HTML, SVG markup, scripts, external resources and arbitrary executable code are not rich-rendering formats; unsupported blocks show source rather than executing.",
].join("\n\n");

export function getClientRenderingSection(
  environment: ProviderEnvironment | undefined,
): string | null {
  return environment?.AGENC_AGENT_SDK_CLIENT_APP === DESKTOP_RICH_RENDERER_CLIENT
    ? DESKTOP_RENDERING_SECTION
    : null;
}
