# Testing

## Frontend

```bash
npm test
npm run build
```

## Analysis Worker

```bash
cd services/analysis-worker
python3 -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
pytest
```

## Agent Package

```bash
cd services/agent
python3 -m venv .venv
. .venv/bin/activate
pip install -e .[dev]
OPENAI_API_KEY=test python -m compileall geoint_agent
OPENAI_API_KEY=test pytest
```

## Manual End-To-End

1. Start `docker compose up -d postgres redis minio analysis-worker agent-server`
2. Start the web app with `npm run dev`
3. If you prefer a local Python agent server instead of the compose service, start it with `langgraph dev`
4. Submit a mission prompt such as:

```text
Create an imagery-first GEOINT package for the Port of Oakland using STAC discovery, NDVI + NDWI + change detection, then summarize maritime activity.
```

5. Verify:
- thread ID persists after reload
- a basemap loads in the center workspace
- live AIS and ADS-B toggles refresh map layers
- artifact layers appear in the layer list after bundle completion
- clicking a track or overlay feature populates the selection panel
- subagent activity appears in the UI
- tool progress cards stream while the worker runs
- artifact bundle cards and preview imagery appear
- final answer includes evidence and methodology language
