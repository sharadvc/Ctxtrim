// ctxtrim CLI: scan a repo, report token cost, optionally write ignore files.
import { existsSync } from "node:fs";
import { scanRepo } from "./scan.js";
import { writeIgnores, TARGETS } from "./ignore.js";
import { textReport, jsonReport } from "./report.js";

const HELP = `ctxtrim — trim what bloats your AI coding context

  Scans a repo, estimates each file's token cost, flags the high-cost / low-value
  files that quietly balloon your Claude Code / Cursor / Codex context (lockfiles,
  generated output, vendored deps, big data), and writes ignore files to cut them.

USAGE
  ctxtrim [path] [options]

OPTIONS
  --write                 create/update the ignore files (default: report only)
  --targets <list>        which to write: cursor,gemini,generic   (default: cursor,gemini)
                            cursor → .cursorignore   gemini → .aiexclude   generic → .aiignore
  --price <usd>           $ per 1M input tokens for the estimate   (default: 3)
  --max-tokens <n>        a file over this counts as "large" data  (default: 2000)
  --top <n>               how many offenders to list                (default: 12)
  --format <text|json>    output format                            (default: text)
  --fail-on-waste <pct>   exit 1 if trimmable context >= pct        (for CI)
  -h, --help / -v, --version

EXAMPLES
  npx ctxtrim                       # report on the current repo
  npx ctxtrim --write               # also write .cursorignore + .aiexclude
  npx ctxtrim ./my-repo --price 15  # estimate at Opus input pricing
  npx ctxtrim --fail-on-waste 40    # CI: fail if 40%+ of context is junk
`;

function parse(argv) {
  const o = { path: null, write: false, targets: "cursor,gemini", price: 3, maxTokens: 2000,
              top: 12, format: "text", failOnWaste: null, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => (a.includes("=") ? a.split("=")[1] : argv[++i]);
    const has = (name) => a === name || a.startsWith(`${name}=`);
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "-v" || a === "--version") o.version = true;
    else if (a === "--write") o.write = true;
    else if (has("--targets")) o.targets = val();
    else if (has("--price")) o.price = Number(val());
    else if (has("--max-tokens")) o.maxTokens = Number(val());
    else if (has("--top")) o.top = Number(val());
    else if (has("--format")) o.format = val();
    else if (has("--fail-on-waste")) o.failOnWaste = Number(val());
    else if (a.startsWith("-")) return { ...o, error: `ctxtrim: unknown option: ${a}\n` };
    else if (!a.startsWith("-")) {
      if (o.path !== null) return { ...o, error: "ctxtrim: only one path may be supplied\n" };
      o.path = a;
    }
  }
  return o;
}

function numericOptionError(o) {
  if (!Number.isFinite(o.price) || o.price < 0)
    return "ctxtrim: invalid --price: expected a non-negative number\n";
  if (!Number.isFinite(o.maxTokens) || o.maxTokens < 0)
    return "ctxtrim: invalid --max-tokens: expected a non-negative number\n";
  if (!Number.isInteger(o.top) || o.top < 0)
    return "ctxtrim: invalid --top: expected a non-negative integer\n";
  if (o.failOnWaste != null && (!Number.isFinite(o.failOnWaste) || o.failOnWaste < 0 || o.failOnWaste > 100))
    return "ctxtrim: invalid --fail-on-waste: expected a percentage from 0 to 100\n";
  return null;
}

export function run(argv, { version }) {
  const o = parse(argv);
  if (o.error) { process.stderr.write(o.error); return 2; }
  if (o.help) { process.stdout.write(HELP); return 0; }
  if (o.version) { process.stdout.write(version + "\n"); return 0; }
  const target = o.path || ".";
  if (!existsSync(target)) { process.stderr.write(`ctxtrim: path not found: ${target}\n`); return 2; }
  const numberError = numericOptionError(o);
  if (numberError) { process.stderr.write(numberError); return 2; }
  if (!["text", "json"].includes(o.format)) { process.stderr.write(`ctxtrim: unknown --format\n`); return 2; }
  const targets = o.targets.split(",").map((s) => s.trim()).filter(Boolean);
  const unknownTargets = targets.filter((s) => !TARGETS[s]);
  if (unknownTargets.length) {
    process.stderr.write(`ctxtrim: unknown --targets: ${unknownTargets.join(", ")}. Valid targets: ${Object.keys(TARGETS).join(", ")}\n`);
    return 2;
  }

  const scan = scanRepo(target, { maxTokens: o.maxTokens });
  let wrote = null;
  if (o.write && scan.patterns.length) wrote = writeIgnores(scan.root, scan.patterns, targets);

  if (o.format === "json") process.stdout.write(jsonReport(scan, { price: o.price, wrote }) + "\n");
  else process.stdout.write(textReport(scan, { price: o.price, top: o.top, wrote }));

  // wastePct >= 0 is always true, so a 0-waste (clean) repo would never pass
  // --fail-on-waste 0; require actual waste to trip the threshold.
  if (o.failOnWaste != null && scan.totals.wastePct >= o.failOnWaste && scan.totals.wastePct > 0) return 1;
  return 0;
}
