import { createClient } from "redis";

const IDS_KEY = "track:ids";

export function createCache(redisUrl) {
  const client = createClient({ url: redisUrl });

  client.on("error", (error) => {
    console.error("redis error", error.message);
  });

  return {
    async init() {
      await client.connect();
    },

    async upsertEvent(event) {
      const key = `track:latest:${event.entity_id}`;
      await client.multi().set(key, JSON.stringify(event), { EX: 600 }).sAdd(IDS_KEY, event.entity_id).exec();
    },

    async getEntity(entityId) {
      const raw = await client.get(`track:latest:${entityId}`);
      return raw ? JSON.parse(raw) : null;
    },

    async listLive(bbox) {
      const ids = await client.sMembers(IDS_KEY);
      if (ids.length === 0) {
        return [];
      }

      const keys = ids.map((id) => `track:latest:${id}`);
      const values = await client.mGet(keys);
      const events = values.filter(Boolean).map((raw) => JSON.parse(raw));

      if (!bbox) {
        return events;
      }

      const [minLon, minLat, maxLon, maxLat] = bbox;
      return events.filter((event) => (
        event.lon >= minLon && event.lon <= maxLon && event.lat >= minLat && event.lat <= maxLat
      ));
    },

    async close() {
      await client.quit();
    }
  };
}
