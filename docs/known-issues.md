# Known Issues

## OPEN: CopilotKit run aborts on the turn after a frontend tool call

**Status:** root cause identified, real fix not yet landed (only a diagnostic
container-side patch was trialed, which does not persist).

### Symptoms (browser console)

A chat run that triggers a map/frontend tool fails. First seen as:

```
[CopilotKit] Error (agent_run_error_event): Error: terminated
```

and, on a tool-using / multi-turn run, the fuller cascade:

```
[CopilotKit] Error (agent_run_failed_event): Cannot send event type 'TEXT_MESSAGE_END':
  The run has already errored with 'RUN_ERROR'. No further events can be sent.
[CopilotKit] Error (agent_run_error_event): This operation was aborted
[CopilotKit] Error (agent_run_error_event): Error: terminated
```

(The separate console line `A listener indicated an asynchronous response ... message
channel closed` is unrelated Chrome-extension noise, not from this app.)

### Root cause

The `agent-runtime` crashes server-side while converting the **incoming** message
history. Traceback ends at:

```
File ".../ag_ui_langgraph/utils.py", in agui_messages_to_langchain
  "args": json.loads(tc.function.arguments) if ... else {},
json.decoder.JSONDecodeError: Extra data: line 1 column 66 (char 65)
```

A frontend tool call's `arguments` string arrives as **valid JSON followed by
trailing junk** (i.e. double-encoded — a complete object then "extra data"). The
unhandled exception aborts the SSE stream mid-run, which CopilotKit's browser
client reports as `RUN_ERROR` → `aborted` → `terminated`.

### When it fires

- NOT on the first user turn (no tool calls in history yet).
- On the turn **after** the agent calls a frontend tool (`focus_map`, `set_aoi`,
  `select_entity`, `refresh_tracks`; defined via `useFrontendTool` in
  `services/ui/src/App.tsx`).
- On turn 1 the agent emits **correct** streamed `TOOL_CALL_ARGS` deltas
  (verified: `{"latitude":...,"longitude":...,"zoom":9}`). The corruption is
  introduced when the **client** (browser → copilot-runtime) sends that assistant
  tool call back on the next turn — so the bug is in the client/runtime
  serialization layer, not in our agent code and not in the model output.

### Versions in play (captured 2026-05-28)

- `agent-runtime` (Python): `ag-ui-langgraph 0.0.36`, `copilotkit 0.1.92`,
  `deepagents 0.6.6`, `langgraph 1.2.2`, `langchain 1.3.2`,
  `langchain-core 1.4.0`, `langchain-openai 1.2.2`
- `ui`: `@copilotkit/react-core 1.58.0`
- `copilot-runtime`: `@copilotkit/runtime` v2 (`createCopilotRuntimeHandler`,
  `injectA2UITool: true`)

Suspected version skew between `@copilotkit/react-core` 1.58 / `@copilotkit/runtime`
v2 / Python `copilotkit` 0.1.92 / `ag-ui-langgraph` 0.0.36 in how tool-call
`arguments` are (de)serialized.

### How to reproduce

1. `docker compose up -d --build`, open the UI (`:3010`).
2. Send a message that forces a frontend tool, e.g. "Focus the map on San
   Francisco" or "Set the AOI to San Francisco, 100 km".
3. Watch it error in the browser; `docker compose logs agent-runtime` shows the
   `JSONDecodeError: Extra data` traceback.

### Diagnostic instrumentation (to capture the exact raw string)

This was trialed inside the running container only (lost on `down`/rebuild). To
re-apply, patch the parse site in `ag_ui_langgraph/utils.py`
(`agui_messages_to_langchain`, the `assistant` branch) to log the raw value and
recover instead of crashing:

```python
for tc in message.tool_calls:
    _raw_args = tc.function.arguments if hasattr(tc, "function") else None
    if _raw_args:
        try:
            _parsed = json.loads(_raw_args)
        except json.JSONDecodeError as _e:
            logging.error("AGUI_BAD_TOOL_ARGS tool=%s err=%s raw=%r",
                          getattr(tc.function, "name", "?"), _e, _raw_args)
            try:
                _parsed, _ = json.JSONDecoder().raw_decode(_raw_args)  # first object
            except Exception:
                _parsed = {}
    else:
        _parsed = {}
    tool_calls.append({"id": tc.id, "name": tc.function.name,
                       "args": _parsed, "type": "tool_call"})
```

Then reproduce in the browser and read `AGUI_BAD_TOOL_ARGS ... raw=...` from the
logs to see the precise corruption (where the trailing junk after char ~65 comes
from). **This is diagnostic only** — do not ship a vendored library edit.

### Candidate real fixes (in priority order)

1. **Capture the raw string first** (instrumentation above) to confirm whether the
   junk is a duplicated object, a concatenated second call, or a framing artifact.
2. **Align CopilotKit/AG-UI versions** across `ui`, `copilot-runtime`, and
   `agent-runtime` so tool-call `arguments` round-trip cleanly. Most likely the
   correct fix.
3. **Normalize in our bridge:** sanitize `tool_calls[].function.arguments` in
   `services/copilot-runtime/server.mjs` before forwarding to `agent-runtime`'s
   `/agui` (take the first valid JSON object). Our code, supportable, but a
   workaround rather than the cause.
