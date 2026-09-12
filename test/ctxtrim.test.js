import fs, { existsSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanRepo, estimateTokens } from "../src/scan.js";
import { classify, classifyPath } from "../src/classify.js";
import { merge, block } from "../src/ignore.js";
import { textReport } from "../src/report.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "sample-repo");
const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "ctxtrim.js");

test("token estimate is ~chars/4", () => {
  assert.equal(estimateTokens("aaaaaaaa"), 2); // 8 chars
  assert.equal(estimateTokens(""), 0);
});

test("classify buckets files correctly", () => {
  assert.equal(classify("package-lock.json", {}).category, "lockfile");
  assert.equal(classify("node_modules/x/index.js", {}).category, "vendored");
  assert.equal(classify("dist/app.js", {}).category, "build");
  assert.equal(classify("app.min.js", {}).category, "minified");
  assert.equal(classify("data/x.csv", {}).category, "data");
  assert.equal(classify("logo.png", {}).binary, true);
  assert.equal(classify("src/index.js", { tokens: 50 }).category, "source");
  assert.equal(classify("src/index.js", { tokens: 50 }).trim, false);
  // big json flagged as data
  assert.equal(classify("big.json", { tokens: 9000, maxTokens: 2000 }).category, "data");
  assert.deepEqual(classifyPath("logo.png"), classify("logo.png", {}));
  assert.equal(classifyPath("generated.js"), null);
  assert.equal(classifyPath("big.json"), null);
});

test("scan skips binary reads and retains content-dependent classification", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ctxtrim-binary-read-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const image = join(root, "pixel.png");
  const document = join(root, "manual.pdf");
  const generated = join(root, "generated.js");
  const largeJson = join(root, "large.json");
  writeFileSync(image, "not really an image");
  writeFileSync(document, "");
  truncateSync(document, 5_000_001);
  writeFileSync(generated, "// @generated\nexport const value = 1;\n");
  writeFileSync(largeJson, JSON.stringify({ payload: "x".repeat(5_100_000) }));

  const readFiles = [];
  const openedFiles = new Map();
  const partialReadFiles = [];
  const readFileSync = fs.readFileSync;
  const openSync = fs.openSync;
  const readSync = fs.readSync;
  t.mock.method(fs, "readFileSync", (...args) => {
    readFiles.push(String(args[0]));
    return readFileSync(...args);
  });
  t.mock.method(fs, "openSync", (...args) => {
    const fd = openSync(...args);
    openedFiles.set(fd, String(args[0]));
    return fd;
  });
  t.mock.method(fs, "readSync", (...args) => {
    partialReadFiles.push(openedFiles.get(args[0]));
    return readSync(...args);
  });
  syncBuiltinESMExports();

  let result;
  try {
    result = scanRepo(root);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  assert.ok(!readFiles.includes(image));
  assert.ok(!readFiles.includes(document));
  assert.ok(![...openedFiles.values()].includes(document));
  assert.ok(!partialReadFiles.includes(document));
  assert.ok(readFiles.includes(generated));
  assert.ok([...openedFiles.values()].includes(largeJson));
  assert.ok(partialReadFiles.includes(largeJson));

  for (const rel of ["pixel.png", "manual.pdf"]) {
    const actual = result.files.find((file) => file.rel === rel);
    const expected = classify(rel, {});
    assert.deepEqual({
      category: actual.category,
      trim: actual.trim,
      binary: actual.binary,
      reason: actual.reason,
    }, expected);
    assert.equal(actual.tokens, 0);
  }
  assert.equal(result.files.find((file) => file.rel === "generated.js").category, "generated");
  assert.equal(result.files.find((file) => file.rel === "large.json").category, "data");
});

test("scan finds trimmable bloat and keeps source", () => {
  const s = scanRepo(repo);
  assert.ok(s.totals.trimTokens > 0);
  assert.ok(s.totals.wastePct > 50, `expected mostly-junk fixture, got ${s.totals.wastePct}%`);
  // the three bloat files are flagged
  const trimmed = new Set(s.files.filter((f) => f.trim).map((f) => f.rel));
  assert.ok(trimmed.has("package-lock.json"));
  assert.ok(trimmed.has("data/seed.json"));
  assert.ok([...trimmed].some((p) => p.startsWith("dist/")));
  // real source is NOT trimmed
  const src = s.files.find((f) => f.rel === "src/index.js");
  assert.equal(src.trim, false);
  // patterns collapse the build dir
  assert.ok(s.patterns.includes("dist/"));
  assert.ok(s.patterns.includes("package-lock.json"));
});

test("ignore block is idempotent (managed block replaced, user lines kept)", () => {
  const patterns = ["dist/", "package-lock.json"];
  const first = merge("# my own rule\n*.log\n", patterns);
  assert.ok(first.includes("# my own rule"));
  assert.ok(first.includes(block(patterns)));
  // re-running with new patterns replaces only the managed block, keeps user lines once
  const second = merge(first, ["dist/", "coverage/"]);
  assert.ok(second.includes("# my own rule"));
  assert.ok(second.includes("coverage/"));
  assert.equal((second.match(/ctxtrim \(managed\)/g) || []).length, 2); // one start, one end
  assert.ok(!second.includes("package-lock.json"), "old managed pattern should be gone");
});

test("ignore merge repairs a managed block with no end marker", () => {
  const existing = [
    "# my own rule",
    "*.log",
    "# >>> ctxtrim (managed) >>>",
    "old-generated-pattern/",
  ].join("\n");

  const repaired = merge(existing, ["dist/", "coverage/"]);

  assert.ok(repaired.includes("# my own rule\n*.log"));
  assert.ok(repaired.includes(block(["dist/", "coverage/"])));
  assert.ok(!repaired.includes("old-generated-pattern/"));
  assert.equal((repaired.match(/ctxtrim \(managed\)/g) || []).length, 2);
});

test("clean repo (only source) reports nothing to trim", () => {
  // scanning the src subdir alone = only source
  const s = scanRepo(join(repo, "src"));
  assert.equal(s.totals.trimTokens, 0);
});

test("scanRepo rejects a file path instead of scanning cwd", () => {
  const file = join(repo, "package-lock.json");
  assert.throws(() => scanRepo(file), /not a directory/);
});

test("CLI rejects a file path with exit 2", () => {
  const file = join(repo, "package-lock.json");
  const result = spawnSync(process.execPath, [cli, file], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /not a directory/);
  assert.equal(result.stdout, "");
});

test("CLI exits 0 on a clean repo with --fail-on-waste 0", () => {
  const result = spawnSync(process.execPath, [cli, join(repo, "src"), "--fail-on-waste", "0"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `wastePct 0 should not trip threshold 0\n${result.stderr}`);
});

test("CLI still fails with --fail-on-waste 0 when there is waste", () => {
  const result = spawnSync(process.execPath, [cli, repo, "--fail-on-waste", "0"], { encoding: "utf8" });
  assert.equal(result.status, 1, "a dirty repo should still fail threshold 0");
});

test("CLI fails only when waste reaches the threshold", () => {
  // the fixture is 100% waste: threshold equal to waste must still fail...
  const equal = spawnSync(process.execPath, [cli, repo, "--fail-on-waste", "100"], { encoding: "utf8" });
  assert.equal(equal.status, 1, "waste at the threshold must fail");
  // ...and a 1% threshold still catches it
  const low = spawnSync(process.execPath, [cli, repo, "--fail-on-waste", "1"], { encoding: "utf8" });
  assert.equal(low.status, 1, "1% threshold should fail a repo with waste");
  // while a clean repo sits well below the threshold
  const pass = spawnSync(process.execPath, [cli, join(repo, "src"), "--fail-on-waste", "50"], { encoding: "utf8" });
  assert.equal(pass.status, 0, `clean repo should pass a 50%% threshold\n${pass.stderr}`);
});

test("CLI rejects non-finite and negative numeric options", () => {
  const invalid = [
    ["--max-tokens", "abc"],
    ["--max-tokens", "-5"],
    ["--price", "-3"],
    ["--top", "-1"],
    ["--fail-on-waste", "abc"],
    ["--fail-on-waste", "-1"],
  ];

  for (const args of invalid) {
    const result = spawnSync(process.execPath, [cli, repo, ...args], { encoding: "utf8" });
    assert.equal(result.status, 2, `${args.join(" ")} should fail with exit 2\n${result.stderr}`);
    assert.match(result.stderr, /ctxtrim: invalid --/);
  }
});

test("unknown --targets values fail before writing ignore files", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ctxtrim-invalid-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package-lock.json"), "{}\n");

  const result = spawnSync(process.execPath, [cli, root, "--write", "--targets", "bogus,cursor"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown --targets: bogus/);
  assert.match(result.stderr, /Valid targets: cursor, gemini, generic/);
  assert.equal(existsSync(join(root, ".cursorignore")), false);
  assert.equal(existsSync(join(root, ".aiexclude")), false);
  assert.equal(existsSync(join(root, ".aiignore")), false);
});
test("duplicate --targets writes and reports each ignore file once", (t) => {
  const root = mkdtempSync(join(tmpdir(), "ctxtrim-duplicate-target-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "package-lock.json"), "{}\n");

  const result = spawnSync(process.execPath, [
    cli, root, "--write", "--format", "json", "--targets", "cursor, gemini,cursor,gemini",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).wrote, [
    { file: ".cursorignore", action: "created", patterns: 1 },
    { file: ".aiexclude", action: "created", patterns: 1 },
  ]);
  assert.equal(existsSync(join(root, ".cursorignore")), true);
  assert.equal(existsSync(join(root, ".aiexclude")), true);
});
test("textReport with top: 0 omits Top offenders header", () => {
  const scan = scanRepo(repo);
  const out = textReport(scan, { price: 3, top: 0 });
  assert.ok(
    !out.includes("Top offenders"),
    "should not show Top offenders header when top is 0",
  );
});
