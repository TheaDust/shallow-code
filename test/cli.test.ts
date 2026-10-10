import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";

import { parseCliArgs, parseInvocation } from "../src/cli.js";

test("Resume and apply have separate inputs and reject unrelated run flags", () => {
  assert.deepEqual(parseInvocation(["resume", "--run-dir", "run", "--budget-ms", "1000"]), {
    command: "resume", runDirectory: resolve("run"), budgetMs: 1000,
  });
  assert.deepEqual(parseInvocation(["apply", "--run-dir", "run", "--allow-partial"]), {
    command: "apply", runDirectory: resolve("run"), allowPartial: true,
  });
  assert.throws(() => parseInvocation(["apply", "--run-dir", "run", "--budget-ms", "10"]), /Unknown/);
  assert.throws(() => parseInvocation(["resume", "--run-dir", "run", "--requirements-dir", "new"]), /Unknown/);
  assert.throws(() => parseInvocation(["resume", "--run-dir", "run", "--budget-ms", "-1"]), /non-negative/);
});

test("CLI resolves required paths and parses a positive budget", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--output-dir",
    "C:/fixture/output",
    "--budget-ms",
    "600000",
  ]);

  assert.deepEqual(parsed, {
    requirementsDir: resolve("C:/fixture/requirements"),
    outputDir: resolve("C:/fixture/output"),
    budgetMs: 600_000,
  });
});

test("CLI applies the configured default output directory when --output-dir is omitted", () => {
  const parsed = parseCliArgs(
    ["--requirements-dir", "C:/fixture/requirements", "--budget-ms", "600000"],
    { defaultOutputDir: "C:/fixture/default-output" },
  );

  assert.equal(parsed.outputDir, resolve("C:/fixture/default-output"));
});

test("CLI prefers an explicit --output-dir over the configured default", () => {
  const parsed = parseCliArgs(
    [
      "--requirements-dir",
      "C:/fixture/requirements",
      "--output-dir",
      "C:/fixture/output",
    ],
    { defaultOutputDir: "C:/fixture/default-output" },
  );

  assert.equal(parsed.outputDir, resolve("C:/fixture/output"));
});

test("CLI rejects a missing --output-dir when no default is configured", () => {
  assert.throws(
    () =>
      parseCliArgs(["--requirements-dir", "C:/fixture/requirements", "--budget-ms", "600000"]),
    /--output-dir/,
  );
});

test("CLI treats an omitted budget as unlimited", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--output-dir",
    "C:/fixture/output",
  ]);

  assert.deepEqual(parsed, {
    requirementsDir: resolve("C:/fixture/requirements"),
    outputDir: resolve("C:/fixture/output"),
    budgetMs: 0,
  });
});

test("CLI accepts an explicit zero budget as unlimited", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--output-dir",
    "C:/fixture/output",
    "--budget-ms",
    "0",
  ]);

  assert.equal(parsed.budgetMs, 0);
});

test("CLI rejects a negative or non-integer budget", () => {
  for (const budget of ["-1", "2.5", "nope"]) {
    assert.throws(
      () =>
        parseCliArgs([
          "--requirements-dir",
          "C:/fixture/requirements",
          "--output-dir",
          "C:/fixture/output",
          "--budget-ms",
          budget,
        ]),
      /--budget-ms/,
    );
  }
});

test("CLI takes over an existing project with --project", () => {
  const parsed = parseCliArgs([
    "--requirements-dir",
    "C:/fixture/requirements",
    "--project",
    "C:/projects/existing-web",
  ]);

  assert.deepEqual(parsed, {
    requirementsDir: resolve("C:/fixture/requirements"),
    outputDir: resolve("C:/projects/existing-web"),
    budgetMs: 0,
    projectDir: resolve("C:/projects/existing-web"),
  });
});

test("CLI rejects naming the run directory twice", () => {
  assert.throws(
    () =>
      parseCliArgs([
        "--requirements-dir",
        "C:/fixture/requirements",
        "--project",
        "C:/projects/existing-web",
        "--output-dir",
        "C:/fixture/output",
      ]),
    /either --project or --output-dir/,
  );
});

test("CLI rejects unknown arguments", () => {
  assert.throws(
    () =>
      parseCliArgs([
        "--requirements-dir",
        "C:/fixture/requirements",
        "--output-dir",
        "C:/fixture/output",
        "--budget-ms",
        "600000",
        "--mystery",
        "value",
      ]),
    /--mystery/,
  );
});
