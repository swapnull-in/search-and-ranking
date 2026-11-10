/**
 * Runs every numbered phase (`npm run phase1`, `phase2`, …) in order and exits
 * non-zero if any of them fails. CI uses it; locally it is a quick smoke test:
 *   node scripts/run-phases.mjs
 *   SKIP_PHASES="phase5 phase6" node scripts/run-phases.mjs   (skip phases that need a broker)
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const scripts = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts;
const skip = new Set((process.env.SKIP_PHASES ?? "").split(/\s+/).filter(Boolean));
const phases = Object.keys(scripts)
  .filter((name) => /^phase\d+$/.test(name))
  .sort((a, b) => Number(a.slice(5)) - Number(b.slice(5)));

const failed = [];
for (const phase of phases) {
  if (skip.has(phase)) { console.log(`\n── ${phase}: skipped`); continue; }
  console.log(`\n── ${phase}`);
  const run = spawnSync("npm", ["run", "-s", phase], { stdio: "inherit", timeout: 120_000 });
  if (run.status !== 0) failed.push(phase);
}

console.log(`\n${phases.length - skip.size - failed.length} phases passed` +
  (skip.size ? `, ${skip.size} skipped` : "") + (failed.length ? `, FAILED: ${failed.join(", ")}` : ""));
process.exit(failed.length ? 1 : 0);
