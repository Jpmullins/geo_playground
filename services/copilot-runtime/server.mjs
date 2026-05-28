import http from "node:http"

import { HttpAgent } from "@ag-ui/client"
import { CopilotRuntime, createCopilotRuntimeHandler } from "@copilotkit/runtime/v2"
import { createCopilotNodeHandler } from "@copilotkit/runtime/v2/node"

const port = Number(process.env.PORT || 8091)
const basePath = "/api/copilotkit"
const agentUrl = process.env.AGENT_AGUI_URL || "http://agent-runtime:8090/agui"

const runtime = new CopilotRuntime({
  agents: {
    default: new HttpAgent({ url: agentUrl })
  },
  a2ui: {
    injectA2UITool: true
  }
})

const copilotHandler = createCopilotNodeHandler(
  createCopilotRuntimeHandler({
    runtime,
    basePath,
    cors: true
  })
)

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    json(res, 200, {
      service: "copilot-runtime",
      status: "ok",
      agent_url: agentUrl,
      a2ui: true
    })
    return
  }

  if (!req.url?.startsWith(basePath)) {
    json(res, 404, { error: "not_found" })
    return
  }

  try {
    await copilotHandler(req, res)
  } catch (error) {
    json(res, 500, {
      error: "copilot_runtime_error",
      detail: error instanceof Error ? error.message : String(error)
    })
  }
})

server.listen(port, () => {
  console.log(`copilot-runtime listening on :${port}`)
})

function json(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  })
  res.end(JSON.stringify(body))
}

