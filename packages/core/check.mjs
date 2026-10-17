/**
 * The core's boundary: what every client imports may lean on nothing one client brings.
 *
 * The desktop draws with React in a Tauri web view and the phone draws native views, so a core file that reached for
 * React, Tauri or the browser would break the phone's build the day it landed. This check makes it break the core's
 * own build instead, in two halves:
 *
 * - every file in `src` imports only other files in `src`: no package at all, so React, Tauri and every browser
 *   library are refused by name, and no triple-slash reference brings a library or a lib back in;
 * - `src` type-checks against the language alone (`tsconfig.json` names no DOM lib and no `@types`), so a browser
 *   global such as `window`, `document` or `localStorage` does not exist. `src/runtime.d.ts` declares the few globals
 *   every client's runtime has.
 *
 *   node packages/core/check.mjs [package folder]    the folder defaults to this one; `pnpm build` runs it first
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
const src = join(root, "src");

function filesIn(folder) {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) return filesIn(path);
    return /\.(c|m)?(t|j)sx?$/.test(entry.name) ? [path] : [];
  });
}

/** Why `specifier`, imported by `file`, crosses the boundary, or null when it names another file in `src`. */
function crossing(file, specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    if (/^(react|react-dom|react-native)(\/|$)/.test(specifier)) return "React is a client's, not the core's";
    if (specifier.startsWith("@tauri-apps/")) return "Tauri is the desktop's, not the core's";
    return "the core imports no package, only its own files";
  }
  const target = resolve(dirname(file), specifier);
  return target.startsWith(src + sep) ? null : "it leaves the core's own files";
}

const problems = [];
for (const file of filesIn(src)) {
  const text = readFileSync(file, "utf8");
  const found = ts.preProcessFile(text, true, true);
  const lines = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
  const at = (position) => `${relative(process.cwd(), file)}:${ts.getLineAndCharacterOfPosition(lines, position).line + 1}`;
  for (const imported of found.importedFiles) {
    const why = crossing(file, imported.fileName);
    if (why) problems.push(`${at(imported.pos)}: imports "${imported.fileName}": ${why}`);
  }
  for (const referenced of found.referencedFiles) {
    const why = crossing(file, referenced.fileName);
    if (why) problems.push(`${at(referenced.pos)}: references "${referenced.fileName}": ${why}`);
  }
  for (const types of found.typeReferenceDirectives) problems.push(`${at(types.pos)}: references types "${types.fileName}": the core takes no package's types`);
  for (const lib of found.libReferenceDirectives) problems.push(`${at(lib.pos)}: references lib "${lib.fileName}": the core runs on the language alone`);
}

const config = ts.getParsedCommandLineOfConfigFile(join(root, "tsconfig.json"), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: (diagnostic) => problems.push(ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")) });
if (config) {
  const program = ts.createProgram({ rootNames: config.fileNames, options: config.options });
  const host = { getCanonicalFileName: (name) => name, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n" };
  for (const diagnostic of [...config.errors, ...ts.getPreEmitDiagnostics(program)]) {
    problems.push(ts.formatDiagnostic(diagnostic, host).trimEnd());
  }
}

if (problems.length) {
  console.error(`The core package crosses its boundary (${relative(process.cwd(), root) || "."}):`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}
