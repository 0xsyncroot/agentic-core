# Build from the repository root. This image is deployed separately from the agent.
ARG BASE_IMAGE=agent-execution-base:node22-python311-v1
FROM node:22-bookworm-slim AS dependencies
WORKDIR /opt/mcp-servers/agent-execution/http
COPY mcp-servers/agent-execution/http/package.json mcp-servers/agent-execution/http/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${BASE_IMAGE} AS runtime
WORKDIR /opt/mcp-servers/document-readers
# Shared reader modules only: the execution image does not contain backend.py or s3_source.py.
COPY mcp-servers/document-readers/file_source.py mcp-servers/document-readers/documents.py \
     mcp-servers/document-readers/xlsx_reader.py mcp-servers/document-readers/xls_reader.py mcp-servers/document-readers/docx_reader.py \
     mcp-servers/document-readers/tables.py mcp-servers/document-readers/errors.py \
     mcp-servers/document-readers/grants.py mcp-servers/document-readers/protocol.py mcp-servers/document-readers/settings.py \
     mcp-servers/document-readers/session.py mcp-servers/document-readers/diagnostics.py \
     mcp-servers/document-readers/tools.py mcp-servers/document-readers/tool_catalog.py \
     mcp-servers/document-readers/header_paths.py mcp-servers/document-readers/cell_tools.py ./
COPY mcp-servers/document-readers/ooxml.py ./
WORKDIR /opt/mcp-servers/agent-execution
COPY mcp-servers/agent-execution/broker.py mcp-servers/agent-execution/file_store.py ./
COPY mcp-servers/agent-execution/http/*.mjs ./http/
COPY --from=dependencies /opt/mcp-servers/agent-execution/http/node_modules ./http/node_modules
COPY mcp-servers/agent-execution/http/package.json ./http/
# EXECUTION_PORT defaults to 8080 in the server; not set here, so a manifest that still sets the retired PORT is not contradicted.
ENV EXECUTION_FILES_DIR=/var/execution-files PYTHONDONTWRITEBYTECODE=1
USER node
EXPOSE 8080
HEALTHCHECK --interval=20s --timeout=5s --start-period=10s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "http/server.mjs"]
