import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { fetchUsage, parseUsage } from "../lib/probe/index.mjs";
import { readResponseBody } from "../lib/probe/http.mjs";

const root = resolve(import.meta.dirname, "..");

test("Node probe parses Codex wham usage and model buckets", async () => {
  const fixture = resolve(root, "tests", "fixtures", "codex-wham-usage.json");
  const usage = await fetchUsage("codex", {
    fixture,
    now: 1760000900
  });

  assert.equal(usage.ok, true);
  assert.equal(usage.util, 93);
  assert.equal(usage.warn_util, 93);
  assert.equal(usage.bucket_id, "additional_rate_limits[GPT-5.3-Codex-Spark].secondary_window");
  assert.equal(usage.reset_epoch, 1760500100);
  assert.equal(usage.reset_after_seconds, 499200);
  assert.equal(usage.buckets.length, 4);
});

test("Node probe exposes codex in parseUsage without network", async () => {
  const raw = JSON.parse(await readFile(resolve(root, "tests", "fixtures", "codex-wham-low.json"), "utf8"));
  const parsed = parseUsage("codex", raw, 1760000900);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.util, 18);
  assert.equal(parsed.bucket_id, "rate_limit.secondary_window");
});

test("response body reader rejects oversized responses before concat", async () => {
  const res = new EventEmitter();
  const promise = readResponseBody(res, { maxBytes: 5 });

  res.emit("data", Buffer.from("abcdef"));
  res.emit("end");

  await assert.rejects(promise, /response_too_large/);
});

