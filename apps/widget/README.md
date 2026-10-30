# Agent Chat widget

A framework-independent chat client for the shared agent HTTP/SSE protocol. UI styles are isolated in a Shadow DOM

Build from the repository root with `npm --workspace @0xsyncroot/chat-widget run build`. Outputs include `dist/agentic-chat-widget.js`, its ESM counterpart and public TypeScript declarations

Run `npm run web` and open `/widget-demo/` to exercise the widget against the full harness

- [Integration API](INTEGRATION.md)
- [Host authentication and deployment](HOST-INTEGRATION.md)
- [Public API source](src/public-api.ts)
