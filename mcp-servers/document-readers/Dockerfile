# HTTP MCP document reader. Stdlib plus xlrd (legacy .xls only), no Node. Reads documents from S3 by documentId.
# Build from this directory: docker build -t document-readers:local .
FROM python:3.12-slim
WORKDIR /opt/document-readers
RUN pip install --no-cache-dir xlrd==2.0.2
COPY errors.py diagnostics.py file_source.py backend.py s3_source.py documents.py xlsx_reader.py xls_reader.py docx_reader.py tables.py ooxml.py \
     grants.py protocol.py settings.py header_paths.py tools.py tool_catalog.py cell_tools.py session.py http_server.py ./
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 DOCUMENT_READERS_PORT=8080
RUN useradd --uid 1000 --no-create-home reader
USER reader
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=5s CMD ["python3", "-c", "import urllib.request as u,sys; sys.exit(0 if u.urlopen(u.Request('http://127.0.0.1:8080/healthz', headers={'Host':'localhost'}), timeout=3).status==200 else 1)"]
CMD ["python3", "http_server.py"]
