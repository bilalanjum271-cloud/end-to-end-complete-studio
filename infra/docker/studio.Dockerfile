# Studio API and Temporal worker share one image; the command selects the role.
#   api:    python -m xen_studio.api.main
#   worker: python -m xen_studio.pipeline.worker
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --uid 10001 app
WORKDIR /app
COPY services/studio/pyproject.toml ./
COPY services/studio/xen_studio ./xen_studio
RUN pip install --no-cache-dir .
USER app
ENV ORCHESTRATOR=temporal MEDIA_ROOT=/data/media
EXPOSE 8104
CMD ["python", "-m", "xen_studio.api.main"]
