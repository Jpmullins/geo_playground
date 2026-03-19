import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "./App";

const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes("/tracking/")) {
    return {
      ok: true,
      json: async () => ({
        source: "adsb",
        mode: "synthetic",
        bbox: [-122.4, 37.7, -122.2, 37.9],
        refreshed_at: "2026-03-19T00:00:00Z",
        summary: { entities: 1, features: 1 },
        geojson: {
          type: "FeatureCollection",
          features: []
        }
      })
    };
  }

  return {
    ok: true,
    json: async () => ({})
  };
});

vi.stubGlobal("fetch", fetchMock);

vi.mock("@langchain/langgraph-sdk/react", () => ({
  useStream: () => ({
    messages: [],
    activeSubagents: [],
    toolProgress: [],
    isLoading: false,
    error: null,
    submit: vi.fn()
  })
}));

vi.mock("maplibre-gl", () => {
  class MockMap {
    handlers: Record<string, Array<(...args: unknown[]) => void>> = {};

    constructor() {
      setTimeout(() => {
        this.handlers.load?.forEach((handler) => handler());
      }, 0);
    }

    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers[event] ??= [];
      this.handlers[event].push(handler);
      return this;
    }

    remove() {}

    getBounds() {
      return {
        getWest: () => -122.4,
        getSouth: () => 37.7,
        getEast: () => -122.2,
        getNorth: () => 37.9
      };
    }

    getStyle() {
      return { sources: {}, layers: [] };
    }

    isStyleLoaded() {
      return true;
    }

    addSource() {}

    addLayer() {}

    addControl() {
      return this;
    }

    removeLayer() {}

    removeSource() {}

    getLayer() {
      return undefined;
    }

    getSource() {
      return undefined;
    }

    fitBounds() {}

    resize() {}

    queryRenderedFeatures() {
      return [];
    }

    getCanvas() {
      return { style: { cursor: "" } };
    }
  }

  return {
    __esModule: true,
    default: {
      Map: MockMap,
      NavigationControl: class NavigationControl {}
    }
  };
});

describe("App", () => {
  it("renders the analyst map workspace", async () => {
    render(<App />);
    expect(screen.getByText("GEOINT Agent Platform")).toBeInTheDocument();
    expect(screen.getByText(/Mission Map/i)).toBeInTheDocument();
    expect(screen.getByText(/Tracking Controls/i)).toBeInTheDocument();
    expect(await screen.findByText(/Map ready|Tracking refreshed|Waiting for AOI and tracks/i)).toBeInTheDocument();
  });
});
