FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml langgraph.json ./
COPY geoint_agent ./geoint_agent
RUN pip install --no-cache-dir -e . langgraph-cli[inmem]
EXPOSE 2024
CMD ["langgraph", "dev", "--host", "0.0.0.0", "--port", "2024"]
