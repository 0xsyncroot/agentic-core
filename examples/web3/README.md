# Read-only Web3 example

A single MCP tool reads an EVM chain snapshot through the full agent harness. It demonstrates capability discovery, permission checks, tool execution, retained results and model interpretation without adding business logic to the kernel

## Run

Build the repository, then add these settings to your ignored root `.env`:

```dotenv
AGENTIC_RUNTIME_PROFILE=development
AGENTIC_LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-key
WEB3_RPC_URL=https://your-evm-rpc-endpoint
```

```sh
npm run demo:web3
npm run demo:web3 -- "Read a chain snapshot and the balance of 0x0000000000000000000000000000000000000000"
```

The runner uses the existing composition root and MCP adapter. It authorizes the current Node executable explicitly and forwards only `WEB3_RPC_URL` to the tool process. Model credentials remain in the harness

## Boundaries

- Only `eth_chainId`, `eth_blockNumber`, `eth_getBlockByNumber` and `eth_getBalance` are reachable
- An optional balance is pinned to the returned block hash with EIP-1898 `requireCanonical: true`; unsupported RPC providers fail explicitly
- Quantities are decimal strings, including native balance in base units; the tool makes no assumptions about a chain's ticker or display decimals
- One overall deadline, bounded response bodies and rejected redirects constrain each snapshot
- The endpoint is trusted deployment configuration. The model supplies only an optional public address

No signing, wallet credentials or transaction submission are implemented. This demonstrates an observed chain state, not finality or provider-independent verification. Offline tests use a controlled RPC fixture; real model and public RPC calls are separate integration checks
