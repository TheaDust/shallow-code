import assert from "node:assert/strict";
import { test } from "node:test";
import { RunBudget } from "../src/run-budget.js";

test("Phase reserves carry unused time forward and stop expired model calls", () => {
  let time = 100;
  const budget = new RunBudget(1_000, time, () => time);
  assert.equal(budget.remaining("implementation"), 600);
  time = 650;
  assert.equal(budget.callTimeout("implementation", 1_000), 50);
  assert.equal(budget.remaining("audit"), 250);
  time = 900;
  assert.equal(budget.remaining("implementation"), 0);
  assert.equal(budget.remaining("repair"), 150);
  assert.equal(budget.remaining("delivery"), 200);
});

test("Explicit unlimited budget still has bounded individual calls", () => {
  const budget = new RunBudget(0, 0, () => 99_999_999);
  assert.equal(budget.remaining("delivery"), Infinity);
  assert.equal(budget.callTimeout("implementation", 600_000), 600_000);
});
