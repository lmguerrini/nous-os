import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const rendererRoots = [resolve(src, "render2d"), resolve(src, "render3f")];
const importPattern = /(?:\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?|\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+)["']([^"']+)["']/gu;

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function resolveImport(from: string, specifier: string): string | null {
  let base: string;
  if (specifier.startsWith("#")) {
    const match = /^#(engine|render2d|render-common|render3f|scene)\/(.*)$/u.exec(specifier);
    if (!match) return null;
    base = resolve(src, match[1]!, match[2]!);
  } else if (specifier.startsWith(".")) base = resolve(dirname(from), specifier);
  else return null;
  if (extname(base)) return existsSync(base) ? base : null;
  return [".ts", ".tsx", ".js"].map((extension) => `${base}${extension}`).find(existsSync) ?? null;
}

test("render2d and render3f dependency graphs do not import review modules", () => {
  const queue = rendererRoots.flatMap(sourceFiles);
  const visited = new Set<string>();
  const violations: string[] = [];
  while (queue.length) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1]!;
      if (specifier.includes("/review/") || specifier.startsWith("#review/")
        || specifier.startsWith("../review/") || specifier.startsWith("./review/")) {
        violations.push(`${file.slice(src.length + 1)} -> ${specifier}`);
        continue;
      }
      const dependency = resolveImport(file, specifier);
      if (dependency && dependency.startsWith(src)) queue.push(dependency);
    }
  }
  assert.deepEqual(violations, [], `renderer dependency graph reaches review modules:\n${violations.join("\n")}`);
});
