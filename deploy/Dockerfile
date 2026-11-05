# Production image for the existing FastAPI backend (ARM64 and x86-64).
#
# Build from the repository root:
#   docker build -f deploy/Dockerfile -t lalithas-backend .
#
# The browser performs speech recognition. The optional server-side
# faster-whisper provider is intentionally not installed here; keeping it out
# makes the image smaller and avoids a native audio/ML stack on the free host.
FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY backend/requirements.txt /tmp/requirements.txt
RUN grep -v '^faster-whisper' /tmp/requirements.txt > /tmp/requirements-core.txt \
    && pip install -r /tmp/requirements-core.txt \
    && rm -f /tmp/requirements.txt /tmp/requirements-core.txt

RUN useradd --create-home --uid 10001 appuser

COPY backend/ /app/
RUN mkdir -p /app/data /app/invoices /app/backups \
    && chown -R appuser:appuser /app

USER appuser

EXPOSE 8000

# The app has no unauthenticated health route, so use the generated OpenAPI
# document: it proves both the ASGI app and the process are serving.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/openapi.json', timeout=4)" || exit 1

# One worker is deliberate: conversation state and login throttling are
# process-local. Use an external queue/session store before scaling out.
# The compose file binds this port to 127.0.0.1 only, behind Caddy, so trusting
# forwarded headers is safe there. Do not publish 8000 directly.
# Keep-alive is raised above Caddy/browser idle time. uvicorn's default of 5s
# can close a connection exactly as a client reuses it, which surfaces as a
# spurious "connection reset" for non-idempotent calls (e.g. voice turns).
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--proxy-headers", "--forwarded-allow-ips", "*", "--timeout-keep-alive", "75"]
