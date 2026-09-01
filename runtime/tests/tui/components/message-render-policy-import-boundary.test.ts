import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, test } from "vitest";

const RUNTIME_SOURCE = resolve(import.meta.dirname, "../../../src");
const MESSAGES = resolve(RUNTIME_SOURCE, "tui/components/Messages.tsx");
const MESSAGE_ROW = resolve(RUNTIME_SOURCE, "tui/components/MessageRow.tsx");
const RENDER_POLICY = resolve(
  RUNTIME_SOURCE,
  "tui/components/messageRenderPolicy.ts",
);

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(?:ts|tsx)$/u.test(entry)
        ? [path]
        : [];
  });
}

const sourceFileSet = new Set(sourceFiles(RUNTIME_SOURCE));

function importCarriesRuntimeValue(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  const bindings = clause.namedBindings;
  if (bindings === undefined || ts.isNamespaceImport(bindings)) return true;
  return bindings.elements.some((element) => !element.isTypeOnly);
}

function exportCarriesRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  const clause = node.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return true;
  return clause.elements.some((element) => !element.isTypeOnly);
}

function runtimeModuleSpecifiers(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const specifiers: string[] = [];

  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      importCarriesRuntimeValue(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      exportCarriesRuntimeValue(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return specifiers;
}

function resolveRuntimeImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const emittedPath = resolve(dirname(from), specifier);
  const sourcePath = emittedPath.endsWith(".js")
    ? emittedPath.slice(0, -3)
    : emittedPath;
  return [
    `${sourcePath}.ts`,
    `${sourcePath}.tsx`,
    resolve(sourcePath, "index.ts"),
    resolve(sourcePath, "index.tsx"),
  ].find((candidate) => sourceFileSet.has(candidate));
}

function runtimeImports(path: string): string[] {
  return runtimeModuleSpecifiers(path).flatMap((specifier) => {
    const imported = resolveRuntimeImport(path, specifier);
    return imported === undefined ? [] : [imported];
  });
}

function findRuntimePath(start: string, target: string): string[] | undefined {
  const pending: Array<{ path: string; trail: string[] }> = [
    { path: start, trail: [start] },
  ];
  const visited = new Set<string>();

  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.path)) continue;
    visited.add(current.path);

    for (const imported of runtimeImports(current.path)) {
      const trail = [...current.trail, imported];
      if (imported === target) return trail;
      if (!visited.has(imported)) pending.push({ path: imported, trail });
    }
  }
  return undefined;
}

describe("message render policy import boundary", () => {
  test("keeps the policy in a leaf shared by Messages and MessageRow", () => {
    expect(runtimeImports(MESSAGES)).toContain(RENDER_POLICY);
    expect(runtimeImports(MESSAGE_ROW)).toContain(RENDER_POLICY);
    expect(runtimeModuleSpecifiers(RENDER_POLICY).sort()).toEqual([
      "../../utils/messages.js",
      "../../utils/set.js",
    ]);
  });

  test("has no runtime path from MessageRow back to Messages", () => {
    const path = findRuntimePath(MESSAGE_ROW, MESSAGES)?.map((entry) =>
      relative(RUNTIME_SOURCE, entry),
    );
    expect(
      path,
      path === undefined
        ? undefined
        : `Runtime import path reintroduced: ${path.join(" -> ")}`,
    ).toBeUndefined();
  });
});
