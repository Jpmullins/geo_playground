import pg from "pg";

const { Pool } = pg;

export function createDb(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl });

  return {
    async init() {
      await pool.query("CREATE EXTENSION IF NOT EXISTS postgis;");
      await pool.query(`
        CREATE TABLE IF NOT EXISTS track_events (
          id BIGSERIAL PRIMARY KEY,
          entity_id TEXT NOT NULL,
          domain TEXT NOT NULL,
          source TEXT NOT NULL,
          ts TIMESTAMPTZ NOT NULL,
          lat DOUBLE PRECISION NOT NULL,
          lon DOUBLE PRECISION NOT NULL,
          event JSONB NOT NULL,
          geom geometry(Point, 4326) NOT NULL
        );
      `);
      await pool.query("CREATE INDEX IF NOT EXISTS idx_track_events_entity_ts ON track_events (entity_id, ts DESC);");
      await pool.query("CREATE INDEX IF NOT EXISTS idx_track_events_geom ON track_events USING GIST (geom);");
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

    async close() {
      await pool.end();
    }
  };
}
