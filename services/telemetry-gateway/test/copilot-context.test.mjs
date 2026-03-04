import test from "node:test";
import assert from "node:assert/strict";
import { buildHistoricalSummaryText, normalizeCopilotOptions } from "../src/copilot-context.mjs";

test("normalizeCopilotOptions applies defaults and clamps lookback", () => {
  const defaults = normalizeCopilotOptions({});
  assert.equal(defaults.lookbackMinutes, 180);
  assert.equal(defaults.domain, null);
  assert.deepEqual(defaults.entityIds, []);

  const clamped = normalizeCopilotOptions({
    lookback_minutes: 999999,
    domain: "AIR",
    entity_ids: ["a", "", "b", null]
  });
  assert.equal(clamped.lookbackMinutes, 10080);
  assert.equal(clamped.domain, "air");
  assert.deepEqual(clamped.entityIds, ["a", "b"]);
});

test("buildHistoricalSummaryText includes evidence-oriented lines", () => {
  const text = buildHistoricalSummaryText({
    lookbackMinutes: 180,
    totalEvents: 2200,
    uniqueEntities: 140,
    airEvents: 2150,
    maritimeEvents: 50,
    maxSpeedKts: 545,
    buckets: [
      { bucketStartIso: "2026-03-04T20:00:00.000Z", events: 120, uniqueEntities: 68, maxSpeedKts: 511 }
    ],
    notableEntities: [
      {
        entityId: "abc123",
        domain: "air",
        samples: 88,
        firstSeenIso: "2026-03-04T20:01:00.000Z",
        lastSeenIso: "2026-03-04T22:59:00.000Z",
        peakSpeedKts: 545
      }
    ]
  });

  assert.match(text, /Historical window \(180m\): events=2200/);
  assert.match(text, /Trend buckets:/);
  assert.match(text, /Notable entities/);
  assert.match(text, /Required output format: include a short Evidence section/);
});
