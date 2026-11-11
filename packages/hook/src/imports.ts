// Which repository files a file imports, for the turn-end stale-dependency check (team context, M.2).
// ponytail: regex over relative imports in JS/TS and Python only; a language-server or tree-sitter graph when other
// languages or path aliases (tsconfig "paths", package exports) matter.
import * as fs from "node:fs";
import * as path from "node:path";

const JS = /\.(?:[cm]?[jt]sx?)$/;
const JS_SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/gm;
const PY_SPEC = /^\s*from\s+(\.+)([\w.]*)\s+import\b/gm;
const JS_EXT = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", "/index.ts", "/index.tsx", "/index.js", "/index.mjs"];

/** Repository-relative paths (forward slashes) of the files `file` imports with a relative specifier. Unreadable: []. */
export function importsOf(root: string, file: string): string[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, file), "utf8");
  } catch {
    return [];
  }
  const dir = path.posix.dirname(file.replaceAll("\\", "/"));
  const found = new Set<string>();
  const add = (candidates: string[]) => {
    const hit = candidates.find((c) => !c.startsWith("..") && isFile(path.join(root, c)));
    if (hit) found.add(hit);
  };
  if (JS.test(file)) {
    for (const [, spec] of text.matchAll(JS_SPEC)) {
      const base = path.posix.normalize(path.posix.join(dir, spec));
      // `./x.js` in TypeScript source means `./x.ts`.
      const stem = base.replace(/\.(?:[cm]?js)$/, "");
      add([...JS_EXT.map((e) => base + e), ...(stem !== base ? JS_EXT.map((e) => stem + e) : [])]);
    }
  } else if (file.endsWith(".py")) {
    for (const [, dots, mod] of text.matchAll(PY_SPEC)) {
      const up = path.posix.join(dir, ...Array(dots.length - 1).fill(".."));
      const base = path.posix.normalize(path.posix.join(up, ...mod.split(".").filter(Boolean)));
      add([base + ".py", base + "/__init__.py"]);
    }
  }
  return [...found];
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
