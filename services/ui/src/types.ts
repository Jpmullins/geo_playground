export type Domain = "air" | "maritime"

export interface Aoi {
  centerLat: number
  centerLon: number
  radiusKm: number
}

export interface TrackIdentity {
  icao?: string | null
  mmsi?: string | null
  callsign?: string | null
  name?: string | null
  registration?: string | null
  type?: string | null
  nav_status?: string | number | null
}

export interface TrackProperties {
  entity_id: string
  domain: Domain
  source: string
  timestamp: string
  lat: number
  lon: number
  speed?: number | null
  course?: number | null
  heading?: number | null
  altitude?: number | null
  identity?: TrackIdentity
  quality?: {
    source_confidence?: number
    position_confidence?: number
    stale_seconds?: number
  }
}

export interface TrackFeature {
  type: "Feature"
  geometry: {
    type: "Point"
    coordinates: [number, number]
  }
  properties: TrackProperties
}

export interface TrackCollection {
  type: "FeatureCollection"
  features: TrackFeature[]
}

export interface PlaceResult {
  name: string
  lat: number
  lon: number
}

