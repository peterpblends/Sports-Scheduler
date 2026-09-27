# Cloud sync server (put it behind HTTPS, e.g. a reverse proxy or your host's TLS).
FROM python:3.12-slim
WORKDIR /srv
COPY server.py ./
COPY app ./app
ENV HFV_DB=/data/sessions.db
VOLUME /data
EXPOSE 8080
# Set HFV_TOKEN at run time to require an access token for sync.
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8080", "--no-mat"]
