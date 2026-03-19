FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml ./
COPY geoint_worker ./geoint_worker
RUN pip install --no-cache-dir -e .
EXPOSE 8090
CMD ["uvicorn", "geoint_worker.app:app", "--host", "0.0.0.0", "--port", "8090"]
