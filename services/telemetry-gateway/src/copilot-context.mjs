const DEFAULT_LOOKBACK_MINUTES = 180;
const MIN_LOOKBACK_MINUTES = 5;
const MAX_LOOKBACK_MINUTES = 24 * 60 * 7;

export function normalizeCopilotOptions(body = {}) {
  const lookbackMinutesRaw = Number(body?.lookback_minutes);
  const lookbackMinutes = Number.isFinite(lookbackMinutesRaw)
    ? Math.max(MIN_LOOKBACK_MINUTES, Math.min(MAX_LOOKBACK_MINUTES, Math.round(lookbackMinutesRaw)))
    : DEFAULT_LOOKBACK_MINUTES;

  const domainRaw = String(body?.domain || "").trim().toLowerCase();
  const domain = domainRaw === "air" || domainRaw === "maritime" ? domainRaw : null;

  const entityIds = Array.isArray(body?.entity_ids)
    ? body.entity_ids
      .map((item) => String(item || "").trim())
      .filter(Boolean)
      .slice(0, 64)
    : [];

  return {
    lookbackMinutes,
    domain,
    entityIds
  };
}

export function buildHistoricalSummaryText(summary) {
  if (!summary || !Number.isFinite(summary.totalEvents) || summary.totalEvents <= 0) {
    return "Historical window summary: no matching historical events in selected lookback.";
  }

  const lines = [
    `Historical window (${summary.lookbackMinutes}m): events=${summary.totalEvents}, unique_entities=${summary.uniqueEntities}, air_events=${summary.airEvents}, maritime_events=${summary.maritimeEvents}, max_speed_kts=${Math.round(summary.maxSpeedKts || 0)}`,
    "Trend buckets:"
  ];

  for (const bucket of summary.buckets.slice(0, 16)) {
    lines.push(
      `- bucket=${bucket.bucketStartIso} events=${bucket.events} unique_entities=${bucket.uniqueEntities} max_speed_kts=${Math.round(bucket.maxSpeedKts || 0)}`
    );
  }

  lines.push("Notable entities (by activity in window):");
  for (const entity of summary.notableEntities.slice(0, 12)) {
    lines.push(
      `- entity=${entity.entityId} domain=${entity.domain} samples=${entity.samples} first=${entity.firstSeenIso} last=${entity.lastSeenIso} peak_speed_kts=${Math.round(entity.peakSpeedKts || 0)}`
    );
  }

  lines.push("Required output format: include a short Evidence section with bullet lines in the form `- [time-range] [entity/region] [metric] [value]`.");
  return lines.join("\n");
}

