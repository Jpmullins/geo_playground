import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import {
  CopilotChat,
  useAgent,
  useAgentContext,
  useFrontendTool
} from "@copilotkit/react-core/v2"
import {
  Activity,
  Crosshair,
  LocateFixed,
  Plane,
  Radar,
  RefreshCw,
  Search,
  Ship,
  ShieldCheck
} from "lucide-react"
import maplibregl, { GeoJSONSource, Map } from "maplibre-gl"
import { z } from "zod"

import type { Aoi, PlaceResult, TrackCollection, TrackFeature, TrackProperties } from "./types"

const apiBase = "/api"
const defaultAoi: Aoi = { centerLat: 37.7749, centerLon: -122.4194, radiusKm: 80 }
const emptyCollection: TrackCollection = { type: "FeatureCollection", features: [] }

export function App() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const [aoi, setAoi] = useState<Aoi>(defaultAoi)
  const [tracks, setTracks] = useState<TrackCollection>(emptyCollection)
  const [trails, setTrails] = useState<GeoJSON.FeatureCollection>(emptyCollection as GeoJSON.FeatureCollection)
  const [selectedEntity, setSelectedEntity] = useState<TrackProperties | null>(null)
  const [updatedAt, setUpdatedAt] = useState<string>("never")
  const [status, setStatus] = useState<string>("initializing")
  const [cityQuery, setCityQuery] = useState<string>("")
  const [cityResults, setCityResults] = useState<PlaceResult[]>([])
  const [lookbackMinutes, setLookbackMinutes] = useState<number>(180)
  const [viewport, setViewport] = useState({ center: [defaultAoi.centerLon, defaultAoi.centerLat], zoom: 6 })
  const [pinMode, setPinMode] = useState<boolean>(false)
  const { agent } = useAgent({ agentId: "default" })
  const aoiRef = useRef(aoi)
  const pinModeRef = useRef(pinMode)
  const applyAoiRef = useRef<(nextAoi: Aoi) => Promise<void>>(async () => undefined)
  const refreshTracksRef = useRef<() => Promise<void>>(async () => undefined)
  const refreshTrailsRef = useRef<() => Promise<void>>(async () => undefined)

  const counts = useMemo(() => {
    const air = tracks.features.filter((feature) => feature.properties.domain === "air").length
    const maritime = tracks.features.filter((feature) => feature.properties.domain === "maritime").length
    return { total: tracks.features.length, air, maritime }
  }, [tracks])

  const visibleEntityIds = useMemo(
    () => tracks.features.slice(0, 60).map((feature) => feature.properties.entity_id),
    [tracks]
  )

  const refreshTracks = useCallback(async () => {
    const response = await fetch(`${apiBase}/tracks/live?bbox=${encodeURIComponent(aoiBboxString(aoiRef.current))}`)
    if (!response.ok) {
      throw new Error(`live tracks HTTP ${response.status}`)
    }
    const payload = await response.json() as TrackCollection
    setTracks(payload)
    setUpdatedAt(new Date().toISOString())
    setStatus(`live picture refreshed: ${payload.features.length} entities`)
    if (selectedEntity) {
      const fresh = payload.features.find((feature) => feature.properties.entity_id === selectedEntity.entity_id)
      if (fresh) {
        setSelectedEntity(fresh.properties)
      }
    }
  }, [selectedEntity])

  const refreshTrails = useCallback(async () => {
    const response = await fetch(`${apiBase}/tracks/trails?minutes=${lookbackMinutes}&max_entities=350&bbox=${encodeURIComponent(aoiBboxString(aoiRef.current))}`)
    if (!response.ok) {
      throw new Error(`trails HTTP ${response.status}`)
    }
    const payload = await response.json() as GeoJSON.FeatureCollection
    setTrails(payload)
  }, [lookbackMinutes])

  const applyAoi = useCallback(async (nextAoi: Aoi) => {
    setStatus("updating AOI")
    const response = await fetch(`${apiBase}/config/aoi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        center_lat: nextAoi.centerLat,
        center_lon: nextAoi.centerLon,
        radius_km: nextAoi.radiusKm
      })
    })
    const payload = await response.json()
    if (!response.ok) {
      throw new Error(payload.detail || payload.error || `AOI HTTP ${response.status}`)
    }
    const updated = {
      centerLat: Number(payload.center_lat),
      centerLon: Number(payload.center_lon),
      radiusKm: Number(payload.radius_km)
    }
    aoiRef.current = updated
    setAoi(updated)
    setStatus(`AOI updated: ${updated.centerLat.toFixed(3)}, ${updated.centerLon.toFixed(3)} / ${Math.round(updated.radiusKm)} km`)
    mapRef.current?.flyTo({ center: [updated.centerLon, updated.centerLat], zoom: Math.max(5.2, mapRef.current.getZoom()) })
  }, [])

  const selectEntity = useCallback(async (entityId: string) => {
    const local = tracks.features.find((feature) => feature.properties.entity_id === entityId)
    if (local) {
      setSelectedEntity(local.properties)
      mapRef.current?.flyTo({ center: [local.properties.lon, local.properties.lat], zoom: 9 })
      return local.properties
    }

    const response = await fetch(`${apiBase}/entities/${encodeURIComponent(entityId)}`)
    if (!response.ok) {
      throw new Error(`entity HTTP ${response.status}`)
    }
    const entity = await response.json() as TrackProperties
    setSelectedEntity(entity)
    if (Number.isFinite(entity.lat) && Number.isFinite(entity.lon)) {
      mapRef.current?.flyTo({ center: [entity.lon, entity.lat], zoom: 9 })
    }
    return entity
  }, [tracks])

  useEffect(() => {
    aoiRef.current = aoi
  }, [aoi])

  useEffect(() => {
    pinModeRef.current = pinMode
  }, [pinMode])

  useEffect(() => {
    applyAoiRef.current = applyAoi
    refreshTracksRef.current = refreshTracks
    refreshTrailsRef.current = refreshTrails
  }, [applyAoi, refreshTracks, refreshTrails])

  useAgentContext({
    description: "Current GEOINT analyst UI state: AOI, map viewport, selected entity, live track counts, visible entity IDs, and historical lookback.",
    value: {
      aoi: {
        centerLat: aoi.centerLat,
        centerLon: aoi.centerLon,
        radiusKm: aoi.radiusKm
      },
      viewport: {
        center: [viewport.center[0], viewport.center[1]],
        zoom: viewport.zoom
      },
      selectedEntity: selectedEntity ? JSON.parse(JSON.stringify(selectedEntity)) : null,
      counts: {
        total: counts.total,
        air: counts.air,
        maritime: counts.maritime
      },
      visibleEntityIds,
      lookbackMinutes,
      lastTelemetryRefresh: updatedAt
    }
  })

  useFrontendTool({
    name: "focus_map",
    description: "Move the analyst map to a latitude, longitude, and optional zoom.",
    parameters: z.object({
      latitude: z.number(),
      longitude: z.number(),
      zoom: z.number().optional(),
      radius_km: z.number().optional()
    }),
    handler: async ({ latitude, longitude, zoom, radius_km }) => {
      mapRef.current?.flyTo({ center: [longitude, latitude], zoom: zoom ?? 8 })
      if (radius_km) {
        setAoi((current) => ({ ...current, centerLat: latitude, centerLon: longitude, radiusKm: radius_km }))
      }
      return { ok: true }
    }
  }, [])

  useFrontendTool({
    name: "select_entity",
    description: "Select and inspect an entity on the map by entity_id.",
    parameters: z.object({ entity_id: z.string() }),
    handler: async ({ entity_id }) => {
      const entity = await selectEntity(entity_id)
      return { ok: true, entity }
    }
  }, [selectEntity])

  useFrontendTool({
    name: "set_aoi",
    description: "Set the platform AOI and refresh local telemetry.",
    parameters: z.object({
      center_lat: z.number(),
      center_lon: z.number(),
      radius_km: z.number()
    }),
    handler: async ({ center_lat, center_lon, radius_km }) => {
      await applyAoi({ centerLat: center_lat, centerLon: center_lon, radiusKm: radius_km })
      await Promise.all([refreshTracks(), refreshTrails()])
      return { ok: true }
    }
  }, [applyAoi, refreshTracks, refreshTrails])

  useFrontendTool({
    name: "refresh_tracks",
    description: "Refresh live tracks and recent trails from telemetry services.",
    parameters: z.object({}),
    handler: async () => {
      await Promise.all([refreshTracks(), refreshTrails()])
      return { ok: true, counts }
    }
  }, [counts, refreshTracks, refreshTrails])

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [aoiRef.current.centerLon, aoiRef.current.centerLat],
      zoom: 6,
      attributionControl: false
    })
    mapRef.current = map
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-left")

    map.on("load", () => {
      ensureMapLayers(map)
      renderAoi(map, aoiRef.current)
      setStatus("map ready")
      refreshTracksRef.current().catch((error) => setStatus(error.message))
      refreshTrailsRef.current().catch(() => undefined)
      for (const layerId of ["air-tracks", "maritime-tracks"]) {
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer"
        })
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "grab"
        })
      }
    })

    map.on("moveend", () => {
      const center = map.getCenter()
      setViewport({ center: [center.lng, center.lat], zoom: Number(map.getZoom().toFixed(2)) })
    })

    map.on("click", (event) => {
      if (pinModeRef.current) {
        const nextAoi = {
          centerLat: Number(event.lngLat.lat.toFixed(5)),
          centerLon: Number(event.lngLat.lng.toFixed(5)),
          radiusKm: aoiRef.current.radiusKm
        }
        setPinMode(false)
        applyAoiRef.current(nextAoi)
          .then(() => Promise.all([refreshTracksRef.current(), refreshTrailsRef.current()]))
          .catch((error) => setStatus(error.message))
        return
      }

      const features = map.queryRenderedFeatures(event.point, { layers: ["air-tracks", "maritime-tracks"] }) as unknown as TrackFeature[]
      if (features.length > 0) {
        setSelectedEntity(features[0].properties)
      }
    })

    return () => {
      map.remove()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) {
      return
    }
    ;(map.getSource("tracks") as GeoJSONSource | undefined)?.setData(tracks as unknown as GeoJSON.FeatureCollection)
  }, [tracks])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) {
      return
    }
    ;(map.getSource("trails") as GeoJSONSource | undefined)?.setData(trails)
  }, [trails])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) {
      return
    }
    renderAoi(map, aoi)
  }, [aoi])

  useEffect(() => {
    fetch(`${apiBase}/config/aoi`)
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`AOI HTTP ${response.status}`)))
      .then((payload) => {
        setAoi({
          centerLat: Number(payload.center_lat),
          centerLon: Number(payload.center_lon),
          radiusKm: Number(payload.radius_km)
        })
      })
      .catch((error) => setStatus(`AOI fallback: ${error.message}`))
  }, [])

  useEffect(() => {
    const liveTimer = window.setInterval(() => {
      refreshTracks().catch((error) => setStatus(error.message))
    }, 5000)
    const trailTimer = window.setInterval(() => {
      refreshTrails().catch(() => undefined)
    }, 15000)
    return () => {
      window.clearInterval(liveTimer)
      window.clearInterval(trailTimer)
    }
  }, [refreshTracks, refreshTrails])

  const searchCity = async () => {
    const query = cityQuery.trim()
    if (!query) {
      return
    }
    setStatus(`searching ${query}`)
    const response = await fetch(`${apiBase}/geocode/search?q=${encodeURIComponent(query)}`)
    if (!response.ok) {
      setStatus(`city search HTTP ${response.status}`)
      return
    }
    const payload = await response.json() as { places?: PlaceResult[] }
    setCityResults(payload.places ?? [])
    setStatus((payload.places ?? []).length ? `found ${(payload.places ?? []).length} place matches` : "no place matches")
  }

  const agentStatus = agent?.isRunning ? "agent running" : "agent idle"

  return (
    <main className="workspace">
      <div ref={mapContainerRef} className="map" />
      <section className="toolbar" aria-label="Analyst controls">
        <div className="brand">
          <Radar size={18} />
          <div>
            <strong>Geo Playground</strong>
            <span>{status}</span>
          </div>
        </div>
        <div className="metric-grid">
          <Metric icon={<Activity size={15} />} label="Total" value={counts.total} />
          <Metric icon={<Plane size={15} />} label="Air" value={counts.air} accent="cyan" />
          <Metric icon={<Ship size={15} />} label="Maritime" value={counts.maritime} accent="amber" />
        </div>
        <div className="control-block">
          <label>Area of Interest</label>
          <div className="field-row">
            <input value={cityQuery} onChange={(event) => setCityQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                searchCity().catch((error) => setStatus(error.message))
              }
            }} placeholder="City or place" />
            <button type="button" title="Search places" onClick={() => searchCity().catch((error) => setStatus(error.message))}>
              <Search size={16} />
            </button>
          </div>
          {cityResults.length > 0 && (
            <div className="place-list">
              {cityResults.slice(0, 4).map((place) => (
                <button key={`${place.name}-${place.lat}-${place.lon}`} type="button" onClick={() => {
                  applyAoi({ centerLat: place.lat, centerLon: place.lon, radiusKm: aoi.radiusKm })
                    .then(() => Promise.all([refreshTracks(), refreshTrails()]))
                    .catch((error) => setStatus(error.message))
                }}>
                  {place.name}
                </button>
              ))}
            </div>
          )}
          <div className="coordinate-grid">
            <NumberInput label="Lat" value={aoi.centerLat} onChange={(value) => setAoi((current) => ({ ...current, centerLat: value }))} step={0.0001} />
            <NumberInput label="Lon" value={aoi.centerLon} onChange={(value) => setAoi((current) => ({ ...current, centerLon: value }))} step={0.0001} />
            <NumberInput label="Radius" value={aoi.radiusKm} onChange={(value) => setAoi((current) => ({ ...current, radiusKm: value }))} step={1} />
          </div>
          <div className="button-grid">
            <button type="button" onClick={() => applyAoi(aoi).then(() => Promise.all([refreshTracks(), refreshTrails()])).catch((error) => setStatus(error.message))}>
              <Crosshair size={16} />
            </button>
            <button type="button" className={pinMode ? "active" : ""} onClick={() => setPinMode((current) => !current)}>
              <LocateFixed size={16} />
            </button>
            <button type="button" onClick={() => Promise.all([refreshTracks(), refreshTrails()]).catch((error) => setStatus(error.message))}>
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
      </section>

      <section className="entity-panel" aria-label="Selected entity">
        <header>
          <span>Selected Entity</span>
          <small>{updatedAt}</small>
        </header>
        {selectedEntity ? <EntityDetails entity={selectedEntity} /> : <p className="empty">Click a track or ask the assistant to inspect an entity.</p>}
      </section>

      <section className="timeline-panel" aria-label="Track timeline">
        <div className="timeline-header">
          <span>Movement Trails</span>
          <select value={lookbackMinutes} onChange={(event) => setLookbackMinutes(Number(event.target.value))}>
            <option value={60}>1h</option>
            <option value={180}>3h</option>
            <option value={720}>12h</option>
            <option value={1440}>24h</option>
          </select>
        </div>
        <TrailStrip tracks={tracks.features} />
      </section>

      <aside className="copilot-panel">
        <div className="copilot-header">
          <div>
            <strong>GEOINT Assistant</strong>
            <span>{agentStatus} · A2UI enabled · map tools available</span>
          </div>
          <ShieldCheck size={18} />
        </div>
        <CopilotChat
          agentId="default"
          labels={{
            modalHeaderTitle: "GEOINT Assistant",
            welcomeMessageText: "Ask for a current picture, AOI change, entity history, or an A2UI card.",
            chatInputPlaceholder: "Ask about the current AOI..."
          }}
        />
      </aside>
    </main>
  )
}

function ensureMapLayers(map: Map) {
  map.addSource("tracks", { type: "geojson", data: emptyCollection as unknown as GeoJSON.FeatureCollection })
  map.addSource("trails", { type: "geojson", data: emptyCollection as unknown as GeoJSON.FeatureCollection })
  map.addSource("aoi-radius", { type: "geojson", data: emptyCollection as unknown as GeoJSON.FeatureCollection })
  map.addSource("aoi-center", { type: "geojson", data: emptyCollection as unknown as GeoJSON.FeatureCollection })

  map.addLayer({
    id: "aoi-radius-fill",
    type: "fill",
    source: "aoi-radius",
    paint: { "fill-color": "#22d3ee", "fill-opacity": 0.08 }
  })
  map.addLayer({
    id: "aoi-radius-line",
    type: "line",
    source: "aoi-radius",
    paint: { "line-color": "#22d3ee", "line-width": 2, "line-opacity": 0.75 }
  })
  map.addLayer({
    id: "air-trails",
    type: "line",
    source: "trails",
    filter: ["==", ["get", "domain"], "air"],
    paint: { "line-color": "#22d3ee", "line-opacity": 0.38, "line-width": 1.5 }
  })
  map.addLayer({
    id: "maritime-trails",
    type: "line",
    source: "trails",
    filter: ["==", ["get", "domain"], "maritime"],
    paint: { "line-color": "#f59e0b", "line-opacity": 0.42, "line-width": 1.5 }
  })
  map.addLayer({
    id: "air-tracks",
    type: "circle",
    source: "tracks",
    filter: ["==", ["get", "domain"], "air"],
    paint: {
      "circle-radius": 4.5,
      "circle-color": "#22d3ee",
      "circle-opacity": 0.95,
      "circle-stroke-color": "#0b1120",
      "circle-stroke-width": 1.2
    }
  })
  map.addLayer({
    id: "maritime-tracks",
    type: "circle",
    source: "tracks",
    filter: ["==", ["get", "domain"], "maritime"],
    paint: {
      "circle-radius": 4.5,
      "circle-color": "#f59e0b",
      "circle-opacity": 0.96,
      "circle-stroke-color": "#0b1120",
      "circle-stroke-width": 1.2
    }
  })
  map.addLayer({
    id: "aoi-center-dot",
    type: "circle",
    source: "aoi-center",
    paint: {
      "circle-radius": 5,
      "circle-color": "#84cc16",
      "circle-stroke-color": "#111827",
      "circle-stroke-width": 2
    }
  })
}

function renderAoi(map: Map, aoi: Aoi) {
  const polygon = radiusPolygon(aoi.centerLon, aoi.centerLat, aoi.radiusKm)
  ;(map.getSource("aoi-radius") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [polygon] },
      properties: {}
    }]
  })
  ;(map.getSource("aoi-center") as GeoJSONSource | undefined)?.setData({
    type: "FeatureCollection",
    features: [{
      type: "Feature",
      geometry: { type: "Point", coordinates: [aoi.centerLon, aoi.centerLat] },
      properties: {}
    }]
  })
}

function aoiBboxString(aoi: Aoi) {
  const latDelta = aoi.radiusKm / 111.32
  const lonDelta = aoi.radiusKm / Math.max(111.32 * Math.cos((aoi.centerLat * Math.PI) / 180), 0.2)
  return [
    aoi.centerLon - lonDelta,
    aoi.centerLat - latDelta,
    aoi.centerLon + lonDelta,
    aoi.centerLat + latDelta
  ].join(",")
}

function radiusPolygon(lon: number, lat: number, radiusKm: number, steps = 96) {
  const coords: [number, number][] = []
  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2
    const latOffset = (radiusKm / 111.32) * Math.sin(angle)
    const lonOffset = (radiusKm / Math.max(111.32 * Math.cos((lat * Math.PI) / 180), 0.2)) * Math.cos(angle)
    coords.push([lon + lonOffset, lat + latOffset])
  }
  return coords
}

function Metric({ icon, label, value, accent = "green" }: { icon: ReactNode, label: string, value: number, accent?: "cyan" | "amber" | "green" }) {
  return (
    <div className={`metric ${accent}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

function NumberInput({ label, value, step, onChange }: { label: string, value: number, step: number, onChange: (value: number) => void }) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input type="number" value={Number.isFinite(value) ? value : 0} step={step} onChange={(event) => onChange(Number(event.target.value))} />
    </label>
  )
}

function EntityDetails({ entity }: { entity: TrackProperties }) {
  const identity = entity.identity ?? {}
  const label = identity.callsign || identity.name || identity.icao || identity.mmsi || entity.entity_id
  const rows = [
    ["Entity", label],
    ["ID", entity.entity_id],
    ["Domain", entity.domain],
    ["Source", entity.source],
    ["Lat/Lon", `${entity.lat.toFixed(4)}, ${entity.lon.toFixed(4)}`],
    ["Speed", entity.speed == null ? "n/a" : `${Math.round(entity.speed)} kts`],
    ["Course", entity.course == null ? "n/a" : `${Math.round(entity.course)}`],
    ["Altitude", entity.altitude == null ? "n/a" : `${Math.round(entity.altitude)} ft`],
    ["Updated", entity.timestamp]
  ]
  return (
    <div className="entity-grid">
      {rows.map(([key, value]) => (
        <div className="entity-row" key={key}>
          <span>{key}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  )
}

function TrailStrip({ tracks }: { tracks: TrackFeature[] }) {
  const rows = tracks.slice(0, 18)
  if (!rows.length) {
    return <div className="trail-empty">Awaiting telemetry inside the AOI.</div>
  }
  return (
    <div className="trail-strip">
      {rows.map((feature) => {
        const entity = feature.properties
        const label = entity.identity?.callsign || entity.identity?.name || entity.entity_id
        const pct = Math.max(4, Math.min(100, Number(entity.speed ?? 0)))
        return (
          <div className="trail-row" key={entity.entity_id}>
            <span className={entity.domain === "air" ? "dot air" : "dot maritime"} />
            <span>{label}</span>
            <div><i style={{ width: `${pct}%` }} /></div>
            <strong>{entity.speed == null ? "n/a" : Math.round(entity.speed)}</strong>
          </div>
        )
      })}
    </div>
  )
}
