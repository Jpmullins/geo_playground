const MAX_HISTORY_PER_ENTITY = 200;

export class TrackStore {
  constructor() {
    this.latestById = new Map();
    this.historyById = new Map();
  }

  upsert(trackEvent) {
    this.latestById.set(trackEvent.entity_id, trackEvent);
    const history = this.historyById.get(trackEvent.entity_id) || [];
    history.push(trackEvent);
    if (history.length > MAX_HISTORY_PER_ENTITY) {
      history.shift();
    }
    this.historyById.set(trackEvent.entity_id, history);
  }

  getEntity(entityId) {
    return this.latestById.get(entityId) || null;
  }

  getHistory(entityId, startIso, endIso) {
    const history = this.historyById.get(entityId) || [];
    const start = startIso ? Date.parse(startIso) : null;
    const end = endIso ? Date.parse(endIso) : null;

    return history.filter((event) => {
      const ts = Date.parse(event.timestamp);
      if (Number.isFinite(start) && ts < start) {
        return false;
      }
      if (Number.isFinite(end) && ts > end) {
        return false;
      }
      return true;
    });
  }

  listLive(bbox) {
    const events = [...this.latestById.values()];
    if (!bbox) {
      return events;
    }

    const [minLon, minLat, maxLon, maxLat] = bbox;
    return events.filter((event) => {
      return event.lon >= minLon && event.lon <= maxLon && event.lat >= minLat && event.lat <= maxLat;
    });
  }
}
