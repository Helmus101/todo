// Dependency audit that fails on high/critical advisories EXCEPT the ones listed here with a reason.
// Run: node scripts/audit-check.mjs   (CI: after the build). Anything new and high still fails.
import { spawnSync } from "node:child_process";

const ALLOWED = {
  // node-forge RSA PKCS#1 v1.5 signature verification. No fixed version exists (1.4.0 is the latest). It only matters to code that VERIFIES
  // RSA signatures; the Pronote client (@blockshub/pawnote-lts) uses forge for byte buffers, hashing, AES and big integers only (checked in
  // its dist: no pki / .verify calls). Remove this entry when node-forge ships a fix.
  "GHSA-86w9-cpqp-85rv": "node-forge: signature verification not used by pawnote",
};

const r = spawnSync("npm", ["audit", "--omit=dev", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
let report;
try { report = JSON.parse(r.stdout); } catch { console.error("npm audit gave no JSON:", r.stdout.slice(0, 300), r.stderr.slice(0, 300)); process.exit(2); }

const advisoryId = (url) => String(url || "").split("/").pop();
const blocking = [];
for (const [name, v] of Object.entries(report.vulnerabilities || {})) {
  if (!["high", "critical"].includes(v.severity)) continue;
  const direct = (v.via || []).filter((x) => typeof x === "object");
  // A package that is only vulnerable THROUGH another package is covered when every advisory below it is allowed.
  if (direct.length && direct.every((x) => ALLOWED[advisoryId(x.url)])) continue;
  if (!direct.length && (v.via || []).every((n) => { const dep = report.vulnerabilities[n]; return dep && (dep.via || []).filter((x) => typeof x === "object").every((x) => ALLOWED[advisoryId(x.url)]); })) continue;
  blocking.push(`${name} (${v.severity})`);
}
const allowed = Object.keys(report.vulnerabilities || {}).length - blocking.length;
if (blocking.length) { console.error(`Blocking advisories: ${blocking.join(", ")}`); process.exit(1); }
console.log(`npm audit: no unallowed high/critical advisories (${allowed} allowlisted, see scripts/audit-check.mjs).`);
