# Environment settings

`scripts/env-registry.mjs` lists supported runtime settings, their owners, defaults, secret classification and legacy aliases. `npm run check:env` checks the registry against actual reads and example files

Use `.env.example` for the local demo. It selects Echo, in-memory storage and an explicitly enabled loopback identity. `.env.production.example` documents a production starting point; it is not a complete production deployment

## Naming

- `AGENTIC_*`: platform behavior and web delivery
- `DEEPSEEK_*`, `OPENAI_*`, `TYPESAFE_*`: model providers
- `DATABASE_URL`, concern-specific database/Redis settings and `S3_*`: infrastructure
- `DOCUMENT_READERS_*`, `EXECUTION_*`: independently deployed MCP services
- `TEST_*`: test-only connection settings, excluded from deployment templates

Configuration is read in composition/delivery and passed to adapters. Persistence migration CLIs and filtered stdio environment forwarding are explicit existing exceptions

Judgment uses the TypeSafe adapter when its key is configured, or when `AGENTIC_JUDGMENT_PROVIDER=typesafe` is explicitly selected. Use `none` to disable it

Credentials must remain in ignored local files or a deployment secret store. Settings warnings name variables rather than values. Do not put keys in browser configuration, examples, test output or committed source
