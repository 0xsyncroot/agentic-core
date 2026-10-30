# Widget integration

## Initialize

Load the built browser script, then initialize the client:

```html
<script src="/assets/agentic-chat-widget.js"></script>
<script>
  const chat = AgentChat.init({
    connection: { baseUrl: "https://agent.example" },
    agent: { id: "default", name: "Assistant" },
    welcomeTitle: "Hello",
    welcomeMessage: "How can I help?"
  });
</script>
```

The example assumes the host supplies an authenticated connection; see [host integration](HOST-INTEGRATION.md). Never put a signing secret or model API key in this snippet

## Connection and context

`connection` selects the backend and authentication headers. `agent` selects presentation and an authorized profile. A custom transport can replace HTTP delivery without changing the widget's presentation contract

`contextProvider` supplies browser-only data for presentation. `agentContextProvider` explicitly selects data sent with agent requests; validate that data again on the server. Neither is authority. `refreshContext()` refreshes context. Welcome text can use resolved host context; business labels belong in the host's `labels` configuration

## Controller

| Purpose | Methods |
| --- | --- |
| Lifecycle | `open`, `close`, `toggle`, `destroy` |
| Conversation | `newSession`, `send`, `interject`, `cancel`, `getSessionId`, `isPending` |
| Presentation | `setCompactMode`, `setMode`, `getMode`, `setDraft`, `isOpen`, `getElement` |
| Files | `addAttachments`, `clearAttachments`, `getAttachments` |
| Context | `refreshContext` |

Host interaction, callout and menu extensions augment this API in the adjacent `public-api-*.ts` declarations. Treat generated declarations as the authoritative type surface

## Streaming and interaction

The widget distinguishes narration from final answers, projects progress and recovers resumable streams. Closing or compacting presentation does not imply cancelling execution. Use `cancel()` for cancellation

Approval, form and external-authorization cards resume through the server interaction route. `onInteractionChange` exposes a pending form to the host; `answerInteraction()` submits its response through the same validated path. It returns false when the card is no longer eligible

Attachments can come from selection, paste, drop or capture. `uploadAttachment` supplies the host's upload contract; file bytes and credential policy remain outside arbitrary model output. Rich UI/custom renderers must keep untrusted content separate from executable host behavior

## Events and embedding

Lifecycle callbacks, action hooks, progress callbacks, session changes, UI actions, feedback, resizing and mode changes are declared in [the public API](src/public-api.ts). Hooks can coordinate host presentation; server authorization still decides whether work may execute

Multiple widgets need independent session/storage keys. Configure CORS and CSP for the chosen backend and assets. Verify reconnect, cancellation, history, interaction expiry, attachments and logout against the actual host before deployment
