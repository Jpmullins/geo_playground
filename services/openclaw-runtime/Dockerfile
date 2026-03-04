FROM alpine:3.22
RUN addgroup -S appgroup && adduser -S appuser -G appgroup -u 10001
USER 10001:10001
WORKDIR /workspace
CMD ["sh", "-c", "sleep infinity"]
