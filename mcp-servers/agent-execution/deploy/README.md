# Execution service deployment

## Build

From the repository root, `npm run mcp:execution:base` builds the reusable runtime base image. `npm run mcp:execution:base:export` prepares its distributable image archive. The service Dockerfile and deployment templates compose the HTTP gateway with that runtime

Use the checked-in Node lockfiles and Python requirements. Supply credentials at runtime, never in image layers or source archives

## Operate

Configure the service token, bind address, allowed hosts, file directory, execution limits and network policy for the target environment. Restrict access to the intended agent backend. Keep uploaded files inside the service's expiring file directory

The local launcher is available through `npm run mcp:execution`. Production deployment needs explicit storage, process isolation and resource policy; local development settings are not a substitute

## Verify

`npm run mcp:execution:test` exercises the gateway after installing its dependencies. The image integration test is `test/integration.mjs`; run it against a prepared service with `EXECUTION_TEST_URL` and the required test configuration. Inspect that test's setup before running it

Verify authentication refusal, file boundaries, timeouts, cancellation and resource exhaustion against the actual image. Keep this service disabled when the product does not need the document/file gateway
