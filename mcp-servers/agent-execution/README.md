# Document and file gateway

An optional isolated service that exposes three document-reading tools through an authenticated Node HTTP gateway. A bounded Python worker pool uses the shared reader dispatcher and an expiring local file store

```sh
npm run mcp:execution:install
npm run mcp:execution:test
npm run mcp:execution
```

Configure `EXECUTION_SERVICE_TOKEN` before startup. The local launcher binds to loopback and loads the repository environment. The gateway handles authentication, file upload/download, request limits and shutdown; the internal stdio bridge keeps discovery responsive while parsing runs in worker threads

The public tools are `read_document`, `read_table` and `read_cells`, with signed read-only resource references. No arbitrary Python or JavaScript execution tool is exposed. The separate document-reader HTTP service remains available for archive-backed deployments

Supply storage credentials only to the component that owns storage. Keep service tokens and uploaded files outside source and image layers. See [deployment](deploy/README.md) for image checks and operational boundaries
