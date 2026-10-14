// Lift a local `const` out of a large function into a top-level function, without changing its body.
//
//   node scripts/extract-local.mjs <file> <enclosingFn> <local> <newFn> [--write]
//
// The local's initializer may be any expression or an arrow function. Its free variables that belong to the
// enclosing function become fields of one typed context object (types come from the TypeScript checker;
// the enclosing function's own parameters are typed as Parameters<typeof enclosingFn>[i]). The new function
// destructures exactly those names, so the moved code reads identically. At the original site the local
// becomes a call (for an expression) or a thin wrapper (for an arrow function).
import ts from "typescript";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [file, fnName, local, newFn] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const write = process.argv.includes("--write");
const path = resolve(file);
const program = ts.createProgram([path], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowImportingTsExtensions: true, noEmit: true, strict: true, jsx: ts.JsxEmit.ReactJSX, skipLibCheck: true });
const checker = program.getTypeChecker();
const sf = program.getSourceFile(path);
const text = sf.getFullText();

let fn; ts.forEachChild(sf, (n) => { if (ts.isFunctionDeclaration(n) && n.name?.text === fnName) fn = n; });
if (!fn) throw new Error(`no function ${fnName}`);
const params = fn.parameters.map((p) => p.name.getText(sf));
const locals = new Map(); // name -> declaration node (any depth inside fn, but only those declared BEFORE the target)
let target;
const collect = (n) => {
  if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) {
    if (n.name.text === local && n.parent.parent.parent === fn.body) target = n;
    else if (!target && n.parent.parent.parent === fn.body) locals.set(n.name.text, n);
  }
  if (!target) ts.forEachChild(n, collect);
};
ts.forEachChild(fn.body, collect);
if (!target) throw new Error(`no top-level local ${local} in ${fnName}`);

const init = target.initializer;
const isArrow = ts.isArrowFunction(init) || ts.isFunctionExpression(init);
const free = new Set();
const visit = (n) => {
  if (ts.isIdentifier(n) && (locals.has(n.text) || params.includes(n.text))) {
    const p = n.parent;
    const isPropName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isShorthandPropertyAssignment(p) && false);
    const sym = checker.getSymbolAtLocation(n);
    const decl = sym?.valueDeclaration;
    const declaredInFn = decl && decl.pos >= fn.body.pos && decl.end <= fn.body.end && !(decl.pos >= init.pos && decl.end <= init.end);
    const isParam = decl && fn.parameters.includes(decl);
    if (!isPropName && (declaredInFn || isParam)) free.add(n.text);
  }
  ts.forEachChild(n, visit);
};
visit(init);

const typeOf = (name) => {
  const pi = params.indexOf(name);
  if (pi >= 0) return `Parameters<typeof ${fnName}>[${pi}]`;
  const decl = locals.get(name);
  return checker.typeToString(checker.getTypeAtLocation(decl.name), undefined, ts.TypeFormatFlags.NoTruncation | ts.TypeFormatFlags.UseAliasDefinedOutsideCurrentScope);
};
const names = [...free].sort();
const ctxType = `${newFn[0].toUpperCase()}${newFn.slice(1)}Context`;
const iface = `interface ${ctxType} {\n${names.map((n) => `  ${n}: ${typeOf(n)};`).join("\n")}\n}`;
const destructure = names.length ? `  const { ${names.join(", ")} } = ctx;\n` : "";

let topFn, callSite;
const initText = text.slice(init.getStart(sf), init.end);
if (isArrow) {
  const ps = init.parameters.map((p) => p.getText(sf)).join(", ");
  const ret = init.type ? `: ${init.type.getText(sf)}` : "";
  const asyncKw = init.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  const body = ts.isBlock(init.body) ? text.slice(init.body.getStart(sf) + 1, init.body.end - 1) : `\n  return ${init.body.getText(sf)};\n`;
  topFn = `${asyncKw}function ${newFn}(ctx: ${ctxType}${ps ? ", " + ps : ""})${ret} {\n${destructure}${body.replace(/^\n/, "")}}`;
  const argNames = init.parameters.map((p) => p.name.getText(sf)).join(", ");
  callSite = `(${ps})${ret} => ${newFn}({ ${names.join(", ")} }${argNames ? ", " + argNames : ""})`;
} else {
  const retType = checker.typeToString(checker.getTypeAtLocation(target.name), undefined, ts.TypeFormatFlags.NoTruncation);
  topFn = `function ${newFn}(ctx: ${ctxType}): ${retType} {\n${destructure}  return ${initText};\n}`;
  callSite = `${newFn}({ ${names.join(", ")} })`;
}
// Self-referencing arrow wrappers (e.g. finish used by runRounds) are fine: the call site keeps the same local name.
let out = text.slice(0, init.getStart(sf)) + callSite + text.slice(init.end);
const fnStart = fn.getFullStart();
const leading = out.slice(0, fnStart);
out = leading + `\n${iface}\n\n${topFn}\n` + out.slice(fnStart);
console.log(`${local} → ${newFn}(ctx: ${ctxType}) with ${names.length} fields: ${names.join(", ")}`);
if (write) writeFileSync(path, out);
