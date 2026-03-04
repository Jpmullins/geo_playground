import pg from "pg";

const { Pool } = pg;

export function createDb(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    async init({ retentionDays = 30 } = {}) {
      await pool.query("CREATE EXTENSION IF NOT EXISTS postgis;");
      const exists = await pool.query(`
        SELECT c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'track_events' AND n.nspname = 'public'
        LIMIT 1
      `);
      if (exists.rows.length === 0) {
        await pool.query(`
          CREATE TABLE track_events (
            id BIGSERIAL,
            entity_id TEXT NOT NULL,
            domain TEXT NOT NULL,
            source TEXT NOT NULL,
            ts TIMESTAMPTZ NOT NULL,
            lat DOUBLE PRECISION NOT NULL,
            lon DOUBLE PRECISION NOT NULL,
            event JSONB NOT NULL,
            geom geometry(Point, 4326) NOT NULL
          ) PARTITION BY RANGE (ts);
        `);
        await pool.query(`
          CREATE TABLE IF NOT EXISTS track_events_default
          PARTITION OF track_events DEFAULT;
        `);
      }
      await pool.query("CREATE INDEX IF NOT EXISTS idx_track_events_entity_ts ON track_events (entity_id, ts DESC);");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_track_events_geom ON track_events USING GIST (geom);");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_track_events_ts ON track_events (ts DESC);");

      await this.ensureFuturePartitions({ weeksAhead: 4, weeksBack: 1 });
      await this.enforceRetention(retentionDays);
    },

    async insertEvent(event) {
      await pool.query(
        `INSERT INTO track_events (entity_id, domain, source, ts, lat, lon, event, geom)
         VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7::jsonb, ST_SetSRID(ST_MakePoint($6, $5), 4326))`,
        [event.entity_id, event.domain, event.source, event.timestamp, event.lat, event.lon, JSON.stringify(event)]
      );
    },

    async getEntity(entityId) {
      const { rows } = await pool.query(
        `SELECT event FROM track_events WHERE entity_id = $1 ORDER BY ts DESC LIMIT 1`,
        [entityId]
      );
      return rows[0]?.event ?? null;
    },

    async getHistory(entityId, startIso, endIso) {
      const { rows } = await pool.query(
        `SELECT event FROM track_events
         WHERE entity_id = $1
         AND ($2::timestamptz IS NULL OR ts >= $2::timestamptz)
         AND ($3::timestamptz IS NULL OR ts <= $3::timestamptz)
         ORDER BY ts ASC LIMIT 1000`,
        [entityId, startIso ?? null, endIso ?? null]
      );
      return rows.map((row) => row.event);
    },

    async listLive(bbox) {
      if (!bbox) {
        const { rows } = await pool.query(
          `SELECT DISTINCT ON (entity_id) event
           FROM track_events
           ORDER BY entity_id, ts DESC
           LIMIT 2000`
        );
        return rows.map((row) => row.event);
      }

      const [minLon, minLat, maxLon, maxLat] = bbox;
      const { rows } = await pool.query(
        `SELECT DISTINCT ON (entity_id) event
         FROM track_events
         WHERE geom && ST_MakeEnvelope($1, $2, $3, $4, 4326)
         ORDER BY entity_id, ts DESC
         LIMIT 2000`,
        [minLon, minLat, maxLon, maxLat]
      );
      return rows.map((row) => row.event);
    },

    async getTrails({ minutes = 30, maxEntities = 300, bbox = null } = {}) {
      const safeMinutes = Math.max(1, Math.min(180, Number(minutes) || 30));
      const safeEntities = Math.max(1, Math.min(500, Number(maxEntities) || 300));

      let bboxClause = "";
      const params = [safeMinutes, safeEntities];
      if (bbox) {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        params.push(minLon, minLat, maxLon, maxLat);
        bboxClause = " AND geom && ST_MakeEnvelope($3, $4, $5, $6, 4326)";
      }

      const { rows } = await pool.query(
        `WITH recent_entities AS (
           SELECT entity_id, max(ts) AS last_ts
           FROM track_events
           WHERE ts >= now() - ($1::int || ' minutes')::interval
           GROUP BY entity_id
           ORDER BY last_ts DESC
           LIMIT $2::int
         )
         SELECT te.entity_id, te.domain, te.lon, te.lat, te.ts
         FROM track_events te
         JOIN recent_entities re ON te.entity_id = re.entity_id
         WHERE te.ts >= now() - ($1::int || ' minutes')::interval${bboxClause}
         ORDER BY te.entity_id ASC, te.ts ASC`,
        params
      );

      return rows;
    },

    async getCopilotHistorySummary({
      minutes = 180,
      bbox = null,
      domain = null,
      entityIds = [],
      bucketMinutes = 10,
      maxNotable = 12
    } = {}) {
      const safeMinutes = Math.max(5, Math.min(24 * 60 * 7, Number(minutes) || 180));
      const safeBucketMinutes = Math.max(1, Math.min(120, Number(bucketMinutes) || 10));
      const safeMaxNotable = Math.max(1, Math.min(50, Number(maxNotable) || 12));

      let whereParts = ["ts >= now() - ($1::int || ' minutes')::interval"];
      const params = [safeMinutes];
      let paramIdx = params.length;

      if (bbox) {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        params.push(minLon, minLat, maxLon, maxLat);
        whereParts.push(`geom && ST_MakeEnvelope($${paramIdx + 1}, $${paramIdx + 2}, $${paramIdx + 3}, $${paramIdx + 4}, 4326)`);
        paramIdx += 4;
      }

      if (domain) {
        params.push(domain);
        whereParts.push(`domain = $${paramIdx + 1}`);
        paramIdx += 1;
      }

      if (Array.isArray(entityIds) && entityIds.length > 0) {
        params.push(entityIds);
        whereParts.push(`entity_id = ANY($${paramIdx + 1}::text[])`);
      }

      const whereSql = whereParts.join(" AND ");

      const totalsResult = await pool.query(
        `SELECT
           COUNT(*)::bigint AS total_events,
           COUNT(DISTINCT entity_id)::bigint AS unique_entities,
           COUNT(*) FILTER (WHERE domain = 'air')::bigint AS air_events,
           COUNT(*) FILTER (WHERE domain = 'maritime')::bigint AS maritime_events,
           COALESCE(MAX((event->>'speed')::double precision), 0)::double precision AS max_speed_kts
         FROM track_events
         WHERE ${whereSql}`,
        params
      );
      const totals = totalsResult.rows[0] || {};

      const bucketParams = [...params, safeBucketMinutes];
      const bucketsResult = await pool.query(
        `SELECT
           to_timestamp(floor(extract(epoch from ts) / ($${bucketParams.length}::int * 60)) * ($${bucketParams.length}::int * 60)) AT TIME ZONE 'UTC' AS bucket_start,
           COUNT(*)::bigint AS events,
           COUNT(DISTINCT entity_id)::bigint AS unique_entities,
           COALESCE(MAX((event->>'speed')::double precision), 0)::double precision AS max_speed_kts
         FROM track_events
         WHERE ${whereSql}
         GROUP BY 1
         ORDER BY 1 ASC
         LIMIT 240`,
        bucketParams
      );

      const notableParams = [...params, safeMaxNotable];
      const notablesResult = await pool.query(
        `SELECT
           entity_id,
           MAX(domain) AS domain,
           COUNT(*)::bigint AS samples,
           MIN(ts) AS first_seen,
           MAX(ts) AS last_seen,
           COALESCE(MAX((event->>'speed')::double precision), 0)::double precision AS peak_speed_kts
         FROM track_events
         WHERE ${whereSql}
         GROUP BY entity_id
         ORDER BY samples DESC, peak_speed_kts DESC
         LIMIT $${notableParams.length}::int`,
        notableParams
      );

      return {
        lookbackMinutes: safeMinutes,
        totalEvents: Number(totals.total_events || 0),
        uniqueEntities: Number(totals.unique_entities || 0),
        airEvents: Number(totals.air_events || 0),
        maritimeEvents: Number(totals.maritime_events || 0),
        maxSpeedKts: Number(totals.max_speed_kts || 0),
        buckets: bucketsResult.rows.map((row) => ({
          bucketStartIso: new Date(row.bucket_start).toISOString(),
          events: Number(row.events || 0),
          uniqueEntities: Number(row.unique_entities || 0),
          maxSpeedKts: Number(row.max_speed_kts || 0)
        })),
        notableEntities: notablesResult.rows.map((row) => ({
          entityId: row.entity_id,
          domain: row.domain,
          samples: Number(row.samples || 0),
          firstSeenIso: new Date(row.first_seen).toISOString(),
          lastSeenIso: new Date(row.last_seen).toISOString(),
          peakSpeedKts: Number(row.peak_speed_kts || 0)
        }))
      };
    },

    async ensureFuturePartitions({ weeksAhead = 4, weeksBack = 1 } = {}) {
      const meta = await pool.query(`
        SELECT p.partstrat
        FROM pg_partitioned_table p
        JOIN pg_class c ON c.oid = p.partrelid
        WHERE c.relname = 'track_events'
        LIMIT 1
      `);
      if (meta.rows.length === 0) {
        return;
      }

      const now = new Date();
      const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const dow = monday.getUTCDay();
      const shift = (dow + 6) % 7;
      monday.setUTCDate(monday.getUTCDate() - shift);

      for (let w = -weeksBack; w <= weeksAhead; w += 1) {
        const from = new Date(monday);
        from.setUTCDate(from.getUTCDate() + (w * 7));
        const to = new Date(from);
        to.setUTCDate(to.getUTCDate() + 7);
        const name = `track_events_y${from.getUTCFullYear()}w${String(getIsoWeek(from)).padStart(2, "0")}`;
        await pool.query(
          `CREATE TABLE IF NOT EXISTS ${name} PARTITION OF track_events FOR VALUES FROM ($1::timestamptz) TO ($2::timestamptz)`,
          [from.toISOString(), to.toISOString()]
        );
      }
    },

    async enforceRetention(days = 30) {
      const safeDays = Math.max(1, Math.min(3650, Number(days) || 30));
      await pool.query(
        `DELETE FROM track_events WHERE ts < now() - ($1::int || ' days')::interval`,
        [safeDays]
      );
    },

    async close() {
      await pool.end();
    }
  };
}

function getIsoWeek(date) {
  const dt = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil((((dt - yearStart) / 86400000) + 1) / 7);
}
