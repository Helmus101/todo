// Move top-level declarations out of a large TS/TSX module into new files, keeping behaviour identical.
//
//   node scripts/split-module.mjs <plan.json> [--write]
//
// plan.json: { "src": "client/App.tsx", "shared": "client/appShared.tsx",
//              "dests": { "client/pages/Settings.tsx": ["SettingsPage", ...], ... },
//              "routes": { "server/routes/auth.ts": { "fn": "registerAuthRoutes", "match": "^/api/auth" } } }
//
// - Each named declaration (with its leading comments) moves to its destination file.
// - An unassigned helper used by exactly one destination (and not by what stays behind) follows it there;
//   a helper used from several files moves to `shared`. Never a circular import back into `src`.
// - "routes" (optional, for Express files): top-level `app.<verb>("<path>", …)` statements whose path matches
//   are wrapped in `export function <fn>(app) { … }`, registered from `src` where the first one stood.
// - Every new file starts with all of src's imports (paths re-based); run the unused-import pruner afterwards.
import ts from "typescript";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

const [planPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const write = process.argv.includes("--write");
const plan = JSON.parse(readFileSync(planPath, "utf8"));
const root = process.cwd();
const srcPath = resolve(root, plan.src);
const text = readFileSync(srcPath, "utf8");
const sf = ts.createSourceFile(srcPath, text, ts.ScriptTarget.Latest, true, srcPath.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const declName = (st) => {
  if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isEnumDeclaration(st)) && st.name) return [st.name.text];
  if (ts.isVariableStatement(st)) return st.declarationList.declarations.flatMap((d) => (ts.isIdentifier(d.name) ? [d.name.text] : []));
  return [];
};
const routePath = (st) => {
  if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression)) return null;
  const callee = st.expression.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.expression.getText(sf) !== "app") return null;
  if (!["get", "post", "put", "patch", "delete", "all"].includes(callee.name.text)) return null;
  const a0 = st.expression.arguments[0];
  return a0 && ts.isStringLiteral(a0) ? a0.text : null;
};

// Top-level units: imports, named declarations, everything else (kept in src, in order).
const units = sf.statements.map((st, i) => ({ st, i, names: declName(st), route: routePath(st), start: st.getFullStart(), end: st.getEnd() }));
const imports = units.filter((u) => ts.isImportDeclaration(u.st));
const byName = new Map();
for (const u of units) for (const n of u.names) byName.set(n, u);

const identsIn = (node) => { const out = new Set(); const v = (n) => { if (ts.isIdentifier(n)) out.add(n.text); ts.forEachChild(n, v); }; v(node); return out; };
// Inside a route unit, `app` is the register function's parameter, not a reference back to src's `app`.
const refs = new Map(units.map((u) => [u, new Set([...identsIn(u.st)].filter((n) => byName.has(n) && !u.names.includes(n) && !(u.route && n === "app")).map((n) => byName.get(n)))]));

// Assign units to files.
const home = new Map(); // unit -> file path (relative), absent = stays in src
for (const [dest, names] of Object.entries(plan.dests || {})) for (const n of names) {
  const u = byName.get(n);
  if (!u) throw new Error(`${n} not found in ${plan.src}`);
  home.set(u, dest);
}
const routeFiles = Object.entries(plan.routes || {});
for (const u of units) if (u.route) for (const [dest, r] of routeFiles) if (new RegExp(r.match).test(u.route)) { home.set(u, dest); break; }

const fileOf = (u) => home.get(u) ?? plan.src;
for (let changed = true; changed;) {
  changed = false;
  for (const u of units) {
    if (!u.names.length || home.has(u) || ts.isImportDeclaration(u.st)) continue;
    const users = new Set(units.filter((x) => x !== u && refs.get(x).has(u)).map(fileOf));
    if (users.size === 0 || (users.size === 1 && users.has(plan.src))) continue;
    if (users.size === 1) { home.set(u, [...users][0]); changed = true; continue; }
    if (plan.shared) { home.set(u, plan.shared); changed = true; }
  }
}

// Which names each file must import from which other file.
const files = new Map(); // path -> { units: [], needs: Map(file -> Set(name)) }
const fileRec = (p) => { if (!files.has(p)) files.set(p, { units: [], needs: new Map() }); return files.get(p); };
fileRec(plan.src);
for (const u of units) if (!ts.isImportDeclaration(u.st)) fileRec(fileOf(u)).units.push(u);
const exported = new Set();
for (const [p, rec] of files) for (const u of rec.units) for (const d of refs.get(u)) {
  const dp = fileOf(d);
  if (dp === p) continue;
  if (p !== plan.src && dp === plan.src) throw new Error(`${p} would import ${d.names.join(",")} back from ${plan.src} — assign it to a file or to shared`);
  const s = rec.needs.get(dp) || new Set(); d.names.forEach((n) => s.add(n)); rec.needs.set(dp, s);
  exported.add(d);
}

const rebase = (spec, from, to) => {
  if (!spec.startsWith(".")) return spec;
  let r = relative(dirname(resolve(root, to)), resolve(dirname(resolve(root, from)), spec));
  if (!r.startsWith(".")) r = "./" + r;
  return r;
};
const importHeader = (target) => imports.map((u) => {
  const t = u.st.getText(sf);
  const spec = u.st.moduleSpecifier.text;
  return t.replace(JSON.stringify(spec), JSON.stringify(rebase(spec, plan.src, target))).replace(`'${spec}'`, `'${rebase(spec, plan.src, target)}'`);
}).join("\n");
const unitText = (u) => {
  let t = text.slice(u.start, u.end).replace(/^\n+/, "");
  if (exported.has(u) && !/^(\s*\/\*[\s\S]*?\*\/\s*|\s*\/\/[^\n]*\n)*\s*export\s/.test(t)) {
    const body = u.st.getStart(sf) - u.start;
    const lead = text.slice(u.start, u.start + body).replace(/^\n+/, "");
    t = lead + "export " + text.slice(u.st.getStart(sf), u.end);
  }
  return t;
};
const importLines = (p, rec) => [...rec.needs].map(([dp, names]) => {
  let spec = relative(dirname(resolve(root, p)), resolve(root, dp)).replace(/\\/g, "/");
  if (!spec.startsWith(".")) spec = "./" + spec;
  return `import { ${[...names].sort().join(", ")} } from "${spec}";`;
}).join("\n");

const out = new Map();
for (const [p, rec] of files) {
  if (p === plan.src) continue;
  const routeUnits = rec.units.filter((u) => u.route);
  const declUnits = rec.units.filter((u) => !u.route);
  const fn = (plan.routes || {})[p]?.fn;
  const rebaseDynamic = (t) => t.replace(/import\("(\.[^"]+)"\)/g, (_, spec) => `import("${rebase(spec, plan.src, p)}")`);
  let body = declUnits.map(unitText).map(rebaseDynamic).join("\n\n");
  if (routeUnits.length) {
    const inner = routeUnits.map((u) => rebaseDynamic(unitText(u)).split("\n").map((l) => (l ? "  " + l : l)).join("\n")).join("\n\n");
    body += `${body ? "\n\n" : ""}export function ${fn}(app: express.Express): void {\n${inner}\n}`;
  }
  out.set(p, `${importHeader(p)}\n${importLines(p, rec)}\n\n${body}\n`);
}
// Rebuild src: keep its own units in order; replace each route group's first statement with its register call.
const srcRec = files.get(plan.src);
const registered = new Set();
let pieces = [importHeader(plan.src), importLines(plan.src, srcRec)];
let srcBody = "";
for (const u of units) {
  if (ts.isImportDeclaration(u.st)) continue;
  const p = fileOf(u);
  if (p === plan.src) { srcBody += text.slice(u.start, u.end); continue; }
  if (u.route && !registered.has(p)) {
    registered.add(p);
    const fn = plan.routes[p].fn;
    let spec = relative(dirname(srcPath), resolve(root, p)); if (!spec.startsWith(".")) spec = "./" + spec;
    pieces.push(`import { ${fn} } from "${spec}";`);
    srcBody += `\n${fn}(app);`;
  }
}
out.set(plan.src, pieces.filter(Boolean).join("\n") + "\n" + srcBody.replace(/^\n+/, "\n") + "\n");

for (const [p, t] of out) {
  console.log(`${p}: ${t.split("\n").length} lines`);
  if (write) { mkdirSync(dirname(resolve(root, p)), { recursive: true }); writeFileSync(resolve(root, p), t); }
}
const moved = [...home].filter(([u, p]) => p === plan.shared).map(([u]) => u.names.join(","));
if (moved.length) console.log(`shared (${plan.shared}): ${moved.join(", ")}`);
