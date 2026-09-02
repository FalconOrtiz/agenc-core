import { PassThrough } from "node:stream";

import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const previewHarness = vi.hoisted(() => ({
  reads: [] as Array<{
    readonly filePath: string;
    readonly offset: number;
    readonly signal: AbortSignal | undefined;
    readonly resolve: (result: {
      readonly content: string;
      readonly lineCount: number;
      readonly totalLines: number;
      readonly totalBytes: number;
      readonly readBytes: number;
      readonly mtimeMs: number;
    }) => void;
  }>,
}));

vi.mock("../../../src/utils/readFileInRange.js", () => ({
  readFileInRange: vi.fn((
    filePath: string,
    offset: number,
    _limit: number,
    _encoding: unknown,
    signal?: AbortSignal,
  ) => {
    let resolve!: (result: {
      readonly content: string;
      readonly lineCount: number;
      readonly totalLines: number;
      readonly totalBytes: number;
      readonly readBytes: number;
      readonly mtimeMs: number;
    }) => void;
    const promise = new Promise<typeof previewHarness.reads[number] extends {
      readonly resolve: (result: infer Result) => void;
    } ? Result : never>((resolvePromise) => {
      resolve = resolvePromise;
    });
    previewHarness.reads.push({ filePath, offset, signal, resolve });
    return promise;
  }),
}));

vi.mock("../../../src/tui/workbench/buffer/highlight.js", () => ({
  highlightBufferVisibleLines: vi.fn(async () => new Map()),
}));

vi.mock("../../../src/tui/workbench/project-tree/gitStatus.js", () => ({
  collectGitStatus: vi.fn(async () => new Map()),
}));

vi.mock("../../../src/tui/keybindings/useKeybinding.js", () => ({
  useInputCapture: () => {},
  useKeybinding: () => {},
  useKeybindings: () => {},
}));

import { createRoot } from "../../../src/tui/ink.js";
import { getInkInstance } from "../../../src/tui/ink/instances.js";
import { cellAt } from "../../../src/tui/ink/screen.js";
import {
  AppStateProvider,
  getDefaultAppState,
} from "../../../src/tui/state/AppState.js";
import { PreviewSurface } from "../../../src/tui/workbench/surfaces/PreviewSurface.js";

type TestStdin = PassThrough & {
  isTTY: boolean;
  ref: () => void;
  setRawMode: (mode: boolean) => void;
  unref: () => void;
};

function createStreams(): {
  readonly stdin: TestStdin;
  readonly stdout: PassThrough;
} {
  const stdout = new PassThrough();
  const stdin = new PassThrough() as TestStdin;

  stdin.isTTY = true;
  stdin.ref = () => {};
  stdin.setRawMode = () => {};
  stdin.unref = () => {};
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).columns = 80;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).rows = 24;
  (stdout as unknown as { columns: number; rows: number; isTTY: boolean }).isTTY = true;
  stdout.resume();

  return { stdin, stdout };
}

function PreviewPathOverrideController({
  initialPath,
  onReady,
}: {
  readonly initialPath: string;
  readonly onReady: (setPathOverride: (filePath: string) => void) => void;
}): React.ReactElement {
  const [pathOverride, setPathOverride] = React.useState(initialPath);
  React.useEffect(() => {
    onReady(setPathOverride);
  }, [onReady]);
  return <PreviewSurface focused={false} pathOverride={pathOverride} />;
}

function sleep(ms = 50): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForPreviewRead(
  fileName: string,
  index = 0,
): Promise<(typeof previewHarness.reads)[number]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const read = previewHarness.reads.filter(({ filePath }) =>
      filePath.endsWith(fileName)
    )[index];
    if (read) return read;
    await sleep(25);
  }
  throw new Error(`Preview read ${index} for ${fileName} did not start`);
}

function resolvePreviewRead(
  read: (typeof previewHarness.reads)[number],
  content: string,
): void {
  read.resolve({
    content,
    lineCount: content.length === 0 ? 0 : content.split("\n").length,
    totalLines: content.length === 0 ? 0 : content.split("\n").length,
    totalBytes: Buffer.byteLength(content),
    readBytes: Buffer.byteLength(content),
    mtimeMs: 1,
  });
}

function screenText(stdout: PassThrough): string {
  const instance = getInkInstance(stdout as unknown as NodeJS.WriteStream) as
    | { readonly frontFrame?: { readonly screen?: { readonly width: number; readonly height: number } } }
    | undefined;
  const screen = instance?.frontFrame?.screen;
  if (!screen) return "";
  const rows: string[] = [];
  for (let row = 0; row < screen.height; row += 1) {
    const chars: string[] = [];
    for (let column = 0; column < screen.width; column += 1) {
      chars.push(cellAt(screen, column, row)?.char ?? " ");
    }
    rows.push(chars.join("").trimEnd());
  }
  return rows.join("\n");
}

describe("PreviewSurface path overrides", () => {
  beforeEach(() => {
    previewHarness.reads = [];
  });

  it("starts override previews at line one and clears old content on navigation", async () => {
    let setPathOverride: ((filePath: string) => void) | null = null;
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "center.ts",
              activeFileLine: 37,
            },
          }}
        >
          <PreviewPathOverrideController
            initialPath="a.ts"
            onReady={(setter) => {
              setPathOverride = setter;
            }}
          />
        </AppStateProvider>,
      );

      const aRead = await waitForPreviewRead("a.ts");
      expect(aRead.offset).toBe(0);
      resolvePreviewRead(aRead, "resolved body from a");
      await sleep();
      expect(screenText(stdout)).toContain("resolved body from a");

      setPathOverride?.("b.ts");
      const bRead = await waitForPreviewRead("b.ts");
      expect(bRead.offset).toBe(0);
      await sleep();

      const pendingFrame = screenText(stdout);
      expect(pendingFrame).toContain("b.ts [read-only");
      expect(pendingFrame).not.toContain("resolved body from a");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });

  it("keeps the newest A preview across deferred A to B to A reads", async () => {
    let setPathOverride: ((filePath: string) => void) | null = null;
    const { stdin, stdout } = createStreams();
    const root = await createRoot({
      patchConsole: false,
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
    });

    try {
      root.render(
        <AppStateProvider
          initialState={{
            ...getDefaultAppState(),
            workbench: {
              ...getDefaultAppState().workbench,
              activeSurfaceMode: "preview",
              activeFilePath: "center.ts",
              activeFileLine: 23,
            },
          }}
        >
          <PreviewPathOverrideController
            initialPath="a.ts"
            onReady={(setter) => {
              setPathOverride = setter;
            }}
          />
        </AppStateProvider>,
      );

      const firstARead = await waitForPreviewRead("a.ts", 0);
      setPathOverride?.("b.ts");
      const bRead = await waitForPreviewRead("b.ts");
      setPathOverride?.("a.ts");
      const newestARead = await waitForPreviewRead("a.ts", 1);

      expect(previewHarness.reads.map(({ offset }) => offset)).toEqual([0, 0, 0]);
      expect(firstARead.signal?.aborted).toBe(true);
      expect(bRead.signal?.aborted).toBe(true);

      resolvePreviewRead(newestARead, "newest a body");
      await sleep();
      expect(screenText(stdout)).toContain("newest a body");

      resolvePreviewRead(bRead, "late b body");
      resolvePreviewRead(firstARead, "late first a body");
      await sleep();

      const settledFrame = screenText(stdout);
      expect(settledFrame).toContain("a.ts [read-only");
      expect(settledFrame).toContain("newest a body");
      expect(settledFrame).not.toContain("late b body");
      expect(settledFrame).not.toContain("late first a body");
    } finally {
      root.unmount();
      stdin.end();
      stdout.end();
    }
  });
});
