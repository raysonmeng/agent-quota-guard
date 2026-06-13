import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("README documents paired budget-guard markers", async () => {
  const readme = await readFile(resolve(root, "README.md"), "utf8");

  assert.match(readme, /<!-- budget-guard:start -->/);
  assert.match(readme, /<!-- budget-guard:end -->/);
  assert.doesNotMatch(readme, /带 `<!-- budget-guard -->` 标记/);
});

test("CLAUDE and HTML docs agree on paired marker wording when markers are mentioned", async () => {
  const files = [
    "CLAUDE.md",
    "docs/budget-guard-final-plan.html",
    "docs/budget-guard-tech-design.html"
  ];

  for (const file of files) {
    const text = await readFile(resolve(root, file), "utf8");
    if (!text.includes("budget-guard")) continue;
    assert.doesNotMatch(text, /<!-- budget-guard -->/);
  }
});

