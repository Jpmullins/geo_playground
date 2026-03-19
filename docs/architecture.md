# Architecture

## Services

- `apps/web`
  - React analyst console
  - Uses `@langchain/langgraph-sdk/react`
  - Streams main conversation, tool progress, and subagent activity
- `services/agent`
  - Python deepagents graph
  - Exposed through LangGraph Agent Server
  - Holds provider adapters and orchestration logic
- `services/analysis-worker`
  - Sandboxed job service
  - Generates artifact bundles, preview files, and live tracking proxy endpoints

## Runtime Contract

- Agent Server assistants/threads/runs are the primary interface.
- The frontend persists `threadId` and reconnects on reload.
- Long-running analysis is delegated to the worker and surfaced as tool/custom progress events.

## Artifact Contract

Each worker job emits a bundle with:

- bundle ID
- artifact list
- summary metrics
- provenance
- confidence metadata
- downloadable preview URLs

The worker also exposes live tracking endpoints for map refresh:

- `/tracking/adsb`
- `/tracking/ais`
- `/tracking/fused`
