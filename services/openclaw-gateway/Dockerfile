FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates git && rm -rf /var/lib/apt/lists/*
RUN npm install -g openclaw@latest
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/bootstrap/start-openclaw.sh"]
