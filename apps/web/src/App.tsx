import {
  FormEvent,
  ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useStream } from "@langchain/langgraph-sdk/react";
import type { Message } from "@langchain/langgraph-sdk";
import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";

type ProgressEvent = {
  type: "progress";
  id: string;
  operation: string;
  message: string;
  progress: number;
};

type ArtifactBundleEvent = {
  type: "artifact_bundle";
  bundle_id: string;
  title: string;
  summary: string;
  preview_urls: string[];
  metrics: Record<string, number | string>;
};

type GeoEvent = ProgressEvent | ArtifactBundleEvent;

type ArtifactRecord = {
  artifact_id: string;
  kind: "raster_preview" | "geojson" | "track_geojson" | "json" | "image";
  label: string;
  uri: string;
  bbox: number[] | null;
  media_type: string;
  default_visible: boolean;
  opacity: number;
  color?: string | null;
};

type ArtifactBundleManifest = {
  bundle_id: string;
  title: string;
  operation: string;
  summary: string;
  bbox: number[];
  time_range: string;
  metrics: Record<string, number | string>;
  preview_urls: string[];
  artifacts: ArtifactRecord[];
  methodology: { mode: string; steps: string[] };
  confidence: { score: number; interval: [number, number]; note: string };
};

type TrackingResponse = {
  source: "adsb" | "ais" | "fused";
  mode: string;
  bbox: number[];
  refreshed_at: string;
  summary: {
    entities: number;
    features: number;
    aircraft?: number;
    vessels?: number;
  };
  geojson: GeoJSON.FeatureCollection;
};

type SelectedFeature = {
  id: string;
  label: string;
  source: string;
  geometryType: string;
  properties: Record<string, unknown>;
};

type LayerEntry = {
  id: string;
  label: string;
  kind: ArtifactRecord["kind"];
  uri: string;
  bbox: number[] | null;
  visible: boolean;
  opacity: number;
  color?: string | null;
};

type TrackingMode = {
  adsb: boolean;
  ais: boolean;
  fused: boolean;
};

type PersistedMapState = {
  trackingMode: TrackingMode;
  layerVisibility: Record<string, boolean>;
  layerOpacity: Record<string, number>;
};

type RemoteGeointAgent = {
  "~agentTypes": {
    Response: unknown;
    State: { messages: Message[] };
    Context: unknown;
    Middleware: unknown;
    Tools: unknown;
  };
  "~deepAgentTypes": {
    Response: unknown;
    State: { messages: Message[] };
    Context: unknown;
    Middleware: unknown;
    Tools: unknown;
    Subagents: readonly [
      { name: "imagery_intel"; description: string },
      { name: "change_interpreter"; description: string },
      { name: "tracking_fusion"; description: string },
      { name: "report_assembler"; description: string }
    ];
  };
};

const apiUrl = import.meta.env.VITE_AGENT_API_URL || "http://localhost:2024";
const assistantId = import.meta.env.VITE_AGENT_ASSISTANT_ID || "geoint-agent";
const analysisApiUrl = import.meta.env.VITE_ANALYSIS_API_URL || "http://localhost:8090";
const mapStatePrefix = "geoint-map-state:";
const defaultMissionBbox = [-77.14, 38.79, -76.88, 39.02] as const;
const trackingColors: Record<"adsb" | "ais" | "fused", string> = {
  adsb: "#7dd3fc",
  ais: "#fde68a",
  fused: "#34d399"
};

function readThreadIdFromLocation() {
  const url = new URL(window.location.href);
  return url.searchParams.get("threadId");
}

function persistThreadId(threadId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("threadId", threadId);
  window.history.replaceState({}, "", url.toString());
}

function renderUnknown(value: unknown): ReactNode {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProgressEvent(event: unknown): event is ProgressEvent {
  return Boolean(event && typeof event === "object" && "type" in event && (event as { type?: string }).type === "progress");
}

function isArtifactBundleEvent(event: unknown): event is ArtifactBundleEvent {
  return Boolean(
    event &&
      typeof event === "object" &&
      "type" in event &&
      (event as { type?: string }).type === "artifact_bundle"
  );
}

function storageKey(threadId: string | null) {
  return `${mapStatePrefix}${threadId || "new"}`;
}

function defaultMapState(): PersistedMapState {
  return {
    trackingMode: {
      adsb: true,
      ais: true,
      fused: true
    },
    layerVisibility: {},
    layerOpacity: {}
  };
}

function loadMapState(threadId: string | null): PersistedMapState {
  const fallback = defaultMapState();
  const raw = window.localStorage.getItem(storageKey(threadId));
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PersistedMapState>;
    return {
      trackingMode: {
        ...fallback.trackingMode,
        ...(parsed.trackingMode || {})
      },
      layerVisibility:
        parsed.layerVisibility && typeof parsed.layerVisibility === "object" ? parsed.layerVisibility : fallback.layerVisibility,
      layerOpacity: parsed.layerOpacity && typeof parsed.layerOpacity === "object" ? parsed.layerOpacity : fallback.layerOpacity
    };
  } catch {
    return fallback;
  }
}

function saveMapState(threadId: string | null, state: PersistedMapState) {
  window.localStorage.setItem(storageKey(threadId), JSON.stringify(state));
}

function bboxToString(bbox: number[]) {
  return bbox.map((value) => value.toFixed(6)).join(",");
}

function fitBounds(map: maplibregl.Map, bbox: number[]) {
  map.fitBounds(
    [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[3]]
    ],
    { padding: 48, duration: 700 }
  );
}

function mapBboxString(map: maplibregl.Map) {
  const bounds = map.getBounds();
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()].map((value) => value.toFixed(6)).join(",");
}

function imageCoordinates(bbox: number[]) {
  return [
    [bbox[0], bbox[3]],
    [bbox[2], bbox[3]],
    [bbox[2], bbox[1]],
    [bbox[0], bbox[1]]
  ] as [[number, number], [number, number], [number, number], [number, number]];
}

function managedSourceIds(map: maplibregl.Map) {
  const style = map.getStyle();
  if (!style?.sources) {
    return [];
  }
  return Object.keys(style.sources).filter((id) => id.startsWith("artifact-") || id.startsWith("tracking-"));
}

function removeManagedLayers(map: maplibregl.Map) {
  const style = map.getStyle();
  if (!style) {
    return;
  }

  const layers = style.layers ?? [];
  for (const layer of [...layers].reverse()) {
    if ((layer.id.startsWith("artifact-") || layer.id.startsWith("tracking-")) && map.getLayer(layer.id)) {
      map.removeLayer(layer.id);
    }
  }
  for (const sourceId of managedSourceIds(map)) {
    if (map.getSource(sourceId)) {
      map.removeSource(sourceId);
    }
  }
}

function buildTrackingGeoJson(response: TrackingResponse, history: Record<string, number[][]>) {
  const features: GeoJSON.Feature[] = [];
  for (const feature of response.geojson.features) {
    features.push(feature);
    if (feature.geometry.type !== "Point") {
      continue;
    }
    const entityId = String((feature.properties as Record<string, unknown>)?.entity_id || "entity");
    const source = String((feature.properties as Record<string, unknown>)?.source || response.source);
    const key = `${source}:${entityId}`;
    const trail = history[key] || [];
    if (trail.length > 1) {
      features.push({
        type: "Feature",
        properties: {
          ...(feature.properties || {}),
          geometry_role: "trail"
        },
        geometry: {
          type: "LineString",
          coordinates: trail
        }
      });
    }
  }
  return {
    type: "FeatureCollection",
    features
  } as GeoJSON.FeatureCollection;
}

function addGeoJsonArtifact(map: maplibregl.Map, layer: LayerEntry) {
  const sourceId = `artifact-${layer.id}`;
  map.addSource(sourceId, {
    type: "geojson",
    data: layer.uri
  });

  const color = layer.color || "#7dd3fc";
  const opacity = Math.max(0.05, Math.min(layer.opacity, 1));

  map.addLayer({
    id: `${sourceId}-fill`,
    type: "fill",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Polygon"],
    paint: {
      "fill-color": color,
      "fill-opacity": opacity * 0.3
    }
  });
  map.addLayer({
    id: `${sourceId}-line`,
    type: "line",
    source: sourceId,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": color,
      "line-width": 2.6,
      "line-opacity": opacity
    }
  });
  map.addLayer({
    id: `${sourceId}-circle`,
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": color,
      "circle-radius": 5,
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#06111c",
      "circle-opacity": opacity
    }
  });
}

function addRasterArtifact(map: maplibregl.Map, layer: LayerEntry) {
  if (!layer.bbox) {
    return;
  }

  const sourceId = `artifact-${layer.id}`;
  map.addSource(sourceId, {
    type: "image",
    url: layer.uri,
    coordinates: imageCoordinates(layer.bbox)
  });
  map.addLayer({
    id: `${sourceId}-raster`,
    type: "raster",
    source: sourceId,
    paint: {
      "raster-opacity": Math.max(0.05, Math.min(layer.opacity, 1))
    }
  });
}

function addTrackingSource(
  map: maplibregl.Map,
  source: "adsb" | "ais" | "fused",
  data: GeoJSON.FeatureCollection,
  opacity: number
) {
  const sourceId = `tracking-${source}`;
  map.addSource(sourceId, {
    type: "geojson",
    data
  });

  map.addLayer({
    id: `${sourceId}-line`,
    type: "line",
    source: sourceId,
    filter: ["==", ["geometry-type"], "LineString"],
    paint: {
      "line-color": trackingColors[source],
      "line-width": 2,
      "line-opacity": opacity * 0.75
    }
  });
  map.addLayer({
    id: `${sourceId}-circle`,
    type: "circle",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    paint: {
      "circle-color": trackingColors[source],
      "circle-radius": source === "fused" ? 8 : 6,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#06111c",
      "circle-opacity": opacity
    }
  });
  map.addLayer({
    id: `${sourceId}-label`,
    type: "symbol",
    source: sourceId,
    filter: ["==", ["geometry-type"], "Point"],
    layout: {
      "text-field": ["coalesce", ["get", "label"], ["get", "entity_id"], source.toUpperCase()],
      "text-size": 11,
      "text-offset": [0, 1.2],
      "text-anchor": "top"
    },
    paint: {
      "text-color": "#edf4ff",
      "text-halo-color": "#06111c",
      "text-halo-width": 1.2,
      "text-opacity": opacity
    }
  });
}

export default function App() {
  const [threadId, setThreadId] = useState<string | null>(() => readThreadIdFromLocation());
  const [prompt, setPrompt] = useState(
    "Create an imagery-first GEOINT package for the Port of Oakland using STAC discovery, NDVI + NDWI + change detection, then summarize maritime activity."
  );
  const [bundles, setBundles] = useState<Map<string, ArtifactBundleManifest>>(new Map());
  const [progressById, setProgressById] = useState<Map<string, ProgressEvent>>(new Map());
  const [selectedFeature, setSelectedFeature] = useState<SelectedFeature | null>(null);
  const [trackingResponses, setTrackingResponses] = useState<Partial<Record<"adsb" | "ais" | "fused", TrackingResponse>>>({});
  const [trackingRevision, setTrackingRevision] = useState(0);
  const [trackingMode, setTrackingMode] = useState<TrackingMode>(() => loadMapState(readThreadIdFromLocation()).trackingMode);
  const [layerVisibility, setLayerVisibility] = useState<Record<string, boolean>>(
    () => loadMapState(readThreadIdFromLocation()).layerVisibility
  );
  const [layerOpacity, setLayerOpacity] = useState<Record<string, number>>(
    () => loadMapState(readThreadIdFromLocation()).layerOpacity
  );
  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapStatus, setMapStatus] = useState("Waiting for AOI and tracks");
  const [lastTrackingRefresh, setLastTrackingRefresh] = useState<string | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const trackHistoryRef = useRef<Record<string, number[][]>>({});

  const hydrateBundle = useCallback(async (bundleId: string) => {
    const response = await fetch(`${analysisApiUrl}/bundles/${bundleId}`);
    if (!response.ok) {
      throw new Error(`Failed to load bundle ${bundleId}`);
    }
    const bundle = (await response.json()) as ArtifactBundleManifest;
    startTransition(() => {
      setBundles((prev) => {
        const next = new Map(prev);
        next.set(bundle.bundle_id, bundle);
        return next;
      });
    });
    return bundle;
  }, []);

  const stream = useStream<RemoteGeointAgent>({
    apiUrl,
    assistantId,
    threadId,
    onThreadId: (id) => {
      setThreadId(id);
      persistThreadId(id);
    },
    reconnectOnMount: true,
    filterSubagentMessages: true,
    onCustomEvent: (event: unknown) => {
      if (isProgressEvent(event)) {
        startTransition(() => {
          setProgressById((prev) => {
            const next = new Map(prev);
            next.set(event.id, event);
            return next;
          });
        });
      }

      if (isArtifactBundleEvent(event)) {
        void hydrateBundle(event.bundle_id).catch((error: unknown) => {
          setMapStatus(`Bundle load failed: ${errorMessage(error)}`);
        });
      }
    }
  });

  useEffect(() => {
    saveMapState(threadId, {
      trackingMode,
      layerVisibility,
      layerOpacity
    });
  }, [threadId, trackingMode, layerVisibility, layerOpacity]);

  useEffect(() => {
    const persisted = loadMapState(threadId);
    setTrackingMode(persisted.trackingMode);
    setLayerVisibility(persisted.layerVisibility);
    setLayerOpacity(persisted.layerOpacity);
  }, [threadId]);

  const bundleList = useMemo(() => Array.from(bundles.values()).reverse(), [bundles]);

  const artifactLayers = useMemo(() => {
    const entries: LayerEntry[] = [];
    for (const bundle of bundleList) {
      for (const artifact of bundle.artifacts) {
        const id = `${bundle.bundle_id}:${artifact.artifact_id}`;
        entries.push({
          id,
          label: `${bundle.title} / ${artifact.label}`,
          kind: artifact.kind,
          uri: artifact.uri,
          bbox: artifact.bbox,
          visible: layerVisibility[id] ?? artifact.default_visible,
          opacity: layerOpacity[id] ?? artifact.opacity,
          color: artifact.color
        });
      }
    }
    return entries;
  }, [bundleList, layerOpacity, layerVisibility]);

  const missionBbox = useMemo(() => bundleList.find((bundle) => Array.isArray(bundle.bbox))?.bbox || null, [bundleList]);

  const activeProgress = useMemo(
    () => Array.from(progressById.values()).sort((a, b) => a.operation.localeCompare(b.operation)),
    [progressById]
  );

  const liveLayers = useMemo(() => {
    const output: Array<{ source: "adsb" | "ais" | "fused"; data: GeoJSON.FeatureCollection }> = [];
    for (const source of ["adsb", "ais", "fused"] as const) {
      if (!trackingMode[source] || !trackingResponses[source]) {
        continue;
      }
      output.push({
        source,
        data: buildTrackingGeoJson(trackingResponses[source] as TrackingResponse, trackHistoryRef.current)
      });
    }
    return output;
  }, [trackingMode, trackingResponses, trackingRevision]);

  const fitMission = useCallback(() => {
    if (mapRef.current && missionBbox) {
      fitBounds(mapRef.current, missionBbox);
    }
  }, [missionBbox]);

  const handleMissionTemplate = useCallback((objective: string) => {
    setPrompt(objective);
  }, []);

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    const message = prompt.trim();
    if (!message) {
      return;
    }

    await stream.submit(
      { messages: [{ type: "human", content: message }] },
      {
        streamSubgraphs: true,
        streamMode: ["updates", "messages-tuple", "values", "custom"]
      }
    );
  };

  const refreshTracking = useCallback(async () => {
    const map = mapRef.current;
    if (!map || !mapLoaded) {
      return;
    }

    const enabledSources = (["adsb", "ais", "fused"] as const).filter((source) => trackingMode[source]);
    if (enabledSources.length === 0) {
      return;
    }

    const bbox = mapBboxString(map);
    setMapStatus("Refreshing live tracking");

    try {
      const responses = await Promise.all(
        enabledSources.map(async (source) => {
          const response = await fetch(`${analysisApiUrl}/tracking/${source}?bbox=${bbox}&limit=40`);
          if (!response.ok) {
            throw new Error(`Tracking request failed for ${source}`);
          }
          const payload = (await response.json()) as TrackingResponse;
          return [source, payload] as const;
        })
      );

      startTransition(() => {
        setTrackingResponses((prev) => {
          const next = { ...prev };
          for (const [source, payload] of responses) {
            next[source] = payload;
            for (const feature of payload.geojson.features) {
              if (feature.geometry.type !== "Point") {
                continue;
              }
              const entityId = String((feature.properties as Record<string, unknown>)?.entity_id || "entity");
              const sourceKey = String((feature.properties as Record<string, unknown>)?.source || source);
              const key = `${sourceKey}:${entityId}`;
              const coordinates = [...feature.geometry.coordinates] as number[];
              const history = trackHistoryRef.current[key] || [];
              const last = history[history.length - 1];
              const changed = !last || last[0] !== coordinates[0] || last[1] !== coordinates[1];
              trackHistoryRef.current[key] = changed ? [...history.slice(-5), coordinates] : history;
            }
          }
          return next;
        });
        setTrackingRevision((value) => value + 1);
      });

      setLastTrackingRefresh(new Date().toLocaleTimeString());
      setMapStatus("Tracking refreshed");
    } catch (error) {
      setMapStatus(`Tracking refresh failed: ${errorMessage(error)}`);
    }
  }, [mapLoaded, trackingMode]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) {
      return;
    }

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          osm: {
            type: "raster",
            tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
            tileSize: 256,
            attribution: "OpenStreetMap contributors"
          }
        },
        layers: [{ id: "osm", type: "raster", source: "osm" }]
      },
      center: [-77.01, 38.907],
      zoom: 10,
      interactive: true
    });

    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      setMapLoaded(true);
      setMapStatus("Map ready");
      map.resize();
      fitBounds(map, missionBbox || [...defaultMissionBbox]);
    });

    map.on("moveend", () => {
      if (trackingMode.adsb || trackingMode.ais || trackingMode.fused) {
        void refreshTracking();
      }
    });

    map.on("click", (event) => {
      const features = map
        .queryRenderedFeatures(event.point)
        .filter((feature) => feature.layer.id.startsWith("artifact-") || feature.layer.id.startsWith("tracking-"));
      const feature = features[0];
      if (!feature) {
        setSelectedFeature(null);
        return;
      }

      const properties = (feature.properties || {}) as Record<string, unknown>;
      setSelectedFeature({
        id: String(properties.entity_id || feature.layer.id),
        label: String(properties.label || properties.kind || feature.layer.id),
        source: String(properties.source || feature.layer.id),
        geometryType: feature.geometry.type,
        properties
      });
    });

    map.on("mousemove", (event) => {
      const features = map
        .queryRenderedFeatures(event.point)
        .filter((feature) => feature.layer.id.startsWith("artifact-") || feature.layer.id.startsWith("tracking-"));
      map.getCanvas().style.cursor = features.length > 0 ? "pointer" : "";
    });

    const handleResize = () => {
      map.resize();
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      map.remove();
      mapRef.current = null;
    };
  }, [missionBbox, refreshTracking, trackingMode.adsb, trackingMode.ais, trackingMode.fused]);

  useEffect(() => {
    const map = mapRef.current;
    const styleReady = typeof map?.isStyleLoaded !== "function" || map.isStyleLoaded();
    if (!map || !mapLoaded || !styleReady) {
      return;
    }

    removeManagedLayers(map);

    for (const layer of artifactLayers) {
      if (!layer.visible) {
        continue;
      }
      if (layer.kind === "geojson" || layer.kind === "track_geojson") {
        addGeoJsonArtifact(map, layer);
        continue;
      }
      if ((layer.kind === "raster_preview" || layer.kind === "image") && layer.bbox) {
        addRasterArtifact(map, layer);
      }
    }

    for (const liveLayer of liveLayers) {
      addTrackingSource(map, liveLayer.source, liveLayer.data, 0.92);
    }
  }, [artifactLayers, liveLayers, mapLoaded]);

  useEffect(() => {
    if (!mapLoaded) {
      return;
    }

    void refreshTracking();
    const intervalId = window.setInterval(() => {
      void refreshTracking();
    }, 15000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [mapLoaded, refreshTracking]);

  useEffect(() => {
    if (mapRef.current && missionBbox && mapLoaded && bundleList.length === 1) {
      fitBounds(mapRef.current, missionBbox);
    }
  }, [bundleList.length, mapLoaded, missionBbox]);

  return (
    <div className="shell workspace-shell">
      <aside className="panel mission-panel">
        <div className="eyebrow">Mission Design</div>
        <h1>GEOINT Agent Platform</h1>
        <p className="muted">
          Threaded analyst workspace with a live map, deep-agent orchestration, artifact layers, and tracking refresh.
        </p>

        <div className="field-group">
          <button
            className="secondary"
            type="button"
            onClick={() =>
              handleMissionTemplate(
                "Search Sentinel-2 imagery around Rafah, compute NDVI, NDWI, NDMI, and NBR, detect significant land-cover change, then summarize confidence and methodology."
              )
            }
          >
            Disaster Assessment
          </button>
          <button
            className="secondary"
            type="button"
            onClick={() =>
              handleMissionTemplate(
                "Inspect a harbor AOI, run change detection and connected-component counting on changed buildings, color changed structures green, then compare with recent vessel activity."
              )
            }
          >
            Harbor Change-Agent
          </button>
        </div>

        <div className="thread-card">
          <span className="label">Assistant</span>
          <code>{assistantId}</code>
          <span className="label">Thread</span>
          <code>{threadId || "new thread"}</code>
          <span className="label">Map Status</span>
          <code>{mapStatus}</code>
        </div>

        <div className="subagent-list">
          <div className="section-title">Active Subagents</div>
          {stream.activeSubagents.length === 0 && <div className="muted">No active subagents.</div>}
          {stream.activeSubagents.map((subagent) => (
            <div key={subagent.id} className="subagent-card">
              <strong>{String(subagent.toolCall.name)}</strong>
              <span>{String(subagent.status)}</span>
            </div>
          ))}
        </div>

        <div className="messages-pane">
          <div className="section-title">Mission Thread</div>
          <div className="messages">
            {stream.messages.length === 0 && (
              <div className="empty-state">
                Submit a mission. The agent will plan, delegate to specialist subagents, and stream worker outputs.
              </div>
            )}
            {stream.messages.map((message, index) => (
              <div key={message.id ?? index} className={`message ${message.type}`}>
                <div className="message-type">{message.type}</div>
                <div className="message-body">{renderUnknown(message.content)}</div>
              </div>
            ))}
          </div>
        </div>

        <form className="composer" onSubmit={handleSubmit}>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the GEOINT mission..."
          />
          <div className="composer-row">
            <div className="muted">{stream.isLoading ? "Mission running..." : "Agent Server connected"}</div>
            <button type="submit" disabled={stream.isLoading}>
              {stream.isLoading ? "Running" : "Launch Mission"}
            </button>
          </div>
          {Boolean(stream.error) && <div className="error">Error: {errorMessage(stream.error)}</div>}
        </form>
      </aside>

      <main className="panel map-panel">
        <div className="map-toolbar">
          <div>
            <div className="section-title">Mission Map</div>
            <div className="muted">AOI context, artifact overlays, and live AIS/ADS-B refresh</div>
          </div>
          <div className="toolbar-actions">
            <button className="secondary" type="button" onClick={fitMission} disabled={!missionBbox}>
              Fit Mission
            </button>
            <button className="secondary" type="button" onClick={() => void refreshTracking()}>
              Refresh Tracks
            </button>
          </div>
        </div>
        <div ref={mapContainerRef} className="map-canvas" />
        <div className="map-footer">
          <span>Live refresh: {lastTrackingRefresh || "pending"}</span>
          <span>Artifacts on map: {artifactLayers.filter((layer) => layer.visible).length}</span>
          <span>Tracking layers: {liveLayers.length}</span>
        </div>
      </main>

      <aside className="panel detail-panel">
        <div className="section-title">Tracking Controls</div>
        <div className="toggle-grid">
          {(["adsb", "ais", "fused"] as const).map((source) => (
            <label key={source} className="toggle-card">
              <span>{source.toUpperCase()}</span>
              <input
                type="checkbox"
                checked={trackingMode[source]}
                onChange={(event) =>
                  setTrackingMode((prev) => ({
                    ...prev,
                    [source]: event.target.checked
                  }))
                }
              />
            </label>
          ))}
        </div>

        <div className="section-title">Map Layers</div>
        <div className="layer-list">
          {artifactLayers.length === 0 && <div className="muted">Spatial artifacts will appear here after the first bundle.</div>}
          {artifactLayers.map((layer) => (
            <div key={layer.id} className="layer-card">
              <label className="layer-row">
                <input
                  type="checkbox"
                  checked={layer.visible}
                  onChange={(event) =>
                    setLayerVisibility((prev) => ({
                      ...prev,
                      [layer.id]: event.target.checked
                    }))
                  }
                />
                <span>{layer.label}</span>
              </label>
              <input
                type="range"
                min="0.1"
                max="1"
                step="0.05"
                value={layer.opacity}
                onChange={(event) =>
                  setLayerOpacity((prev) => ({
                    ...prev,
                    [layer.id]: Number(event.target.value)
                  }))
                }
              />
            </div>
          ))}
        </div>

        <div className="section-title">Selected Feature</div>
        {selectedFeature ? (
          <div className="selected-card">
            <strong>{selectedFeature.label}</strong>
            <div className="muted">
              {selectedFeature.source} / {selectedFeature.geometryType}
            </div>
            <pre>{JSON.stringify(selectedFeature.properties, null, 2)}</pre>
          </div>
        ) : (
          <div className="empty-state">Click a track or overlay feature on the map to inspect it.</div>
        )}

        <div className="section-title">Tool Progress</div>
        <div className="progress-grid">
          {activeProgress.length === 0 && <div className="muted">Waiting for tool activity.</div>}
          {activeProgress.map((progress) => (
            <div key={progress.id} className="progress-card">
              <strong>{progress.operation}</strong>
              <span>{progress.message}</span>
              <div className="meter">
                <div style={{ width: `${progress.progress}%` }} />
              </div>
            </div>
          ))}
        </div>

        <div className="section-title">Artifact Bundles</div>
        {bundleList.length === 0 && (
          <div className="empty-state">
            Bundle summaries and map-ready artifacts will appear here as worker jobs complete.
          </div>
        )}
        {bundleList.map((bundle) => (
          <div key={bundle.bundle_id} className="artifact-card">
            <div className="artifact-head">
              <strong>{bundle.title}</strong>
              <code>{bundle.bundle_id}</code>
            </div>
            <p>{bundle.summary}</p>
            <div className="metrics">
              {Object.entries(bundle.metrics).map(([key, value]) => (
                <div key={key} className="metric">
                  <span>{key}</span>
                  <strong>{String(value)}</strong>
                </div>
              ))}
            </div>
            <div className="preview-grid">
              {bundle.preview_urls.map((url) => (
                <img key={url} src={url} alt={bundle.title} />
              ))}
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}
