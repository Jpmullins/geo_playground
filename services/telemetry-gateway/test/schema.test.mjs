import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAdsbRecord, normalizeAisMessage, validateTrackEvent } from "../src/schema.mjs";

test("normalizeAdsbRecord returns canonical TrackEvent", () => {
  const record = {
    hex: "A125F9",
    lat: 38.5,
    lon: -122.9,
    gs: 220.5,
    track: 236.9,
    true_heading: 238,
    alt_baro: 4500,
    flight: "SKW3315 ",
    r: "N173SY",
    t: "E75L",
    seen_pos: 2
  };

  const event = normalizeAdsbRecord(record, "adsbfi");
  assert.ok(event);
  assert.equal(event.entity_id, "a125f9");
  assert.equal(event.domain, "air");
  assert.equal(event.identity.callsign, "SKW3315");
  assert.equal(event.identity.registration, "N173SY");
  assert.equal(validateTrackEvent(event), true);
});

test("normalizeAisMessage returns maritime TrackEvent", () => {
  const msg = {
    MetaData: {
      MMSI: 123456789,
      CallSign: "WDC123",
      ShipName: "TEST VESSEL"
    },
    Message: {
      PositionReport: {
        Latitude: 37.8,
        Longitude: -122.4,
        Sog: 12.2,
        Cog: 95.1,
        TrueHeading: 96,
        NavigationalStatus: 0
      }
    }
  };

  const event = normalizeAisMessage(msg, "aisstream");
  assert.ok(event);
  assert.equal(event.domain, "maritime");
  assert.equal(event.entity_id, "mmsi:123456789");
  assert.equal(event.identity.callsign, "WDC123");
  assert.equal(validateTrackEvent(event), true);
});

test("normalizeAdsbRecord returns null if coordinates missing", () => {
  const event = normalizeAdsbRecord({ hex: "abc" }, "adsbfi");
  assert.equal(event, null);
});
