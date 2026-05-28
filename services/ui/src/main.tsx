import React from "react"
import { createRoot } from "react-dom/client"
import { CopilotKitProvider } from "@copilotkit/react-core/v2"
import "@copilotkit/react-core/v2/styles.css"
import "maplibre-gl/dist/maplibre-gl.css"

import { App } from "./App"
import "./styles.css"

createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <CopilotKitProvider
      runtimeUrl="/api/copilotkit"
      showDevConsole="auto"
      a2ui={{ includeSchema: true }}
      defaultThrottleMs={100}
    >
      <App />
    </CopilotKitProvider>
  </React.StrictMode>
)

