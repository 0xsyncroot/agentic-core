/**
 * A card the host shows beside the assistant (ui/callout.ts): a summary it wants noticed, with a
 * few buttons. These merge into the declarations of public-api.ts.
 */

interface AgentChatCalloutAction { readonly id: string; readonly label: string; readonly primary?: boolean }

/** Shown above the launcher while the panel is closed, beside the panel while it is open. */
interface AgentChatCallout {
  /** 1-64 characters. Showing the same id again updates the card in place. */
  readonly id: string;
  readonly title: string;
  /** Rendered with the widget's own safe Markdown subset (bullets, bold, links). */
  readonly markdown: string;
  /** At most three buttons; more are ignored. */
  readonly actions?: readonly AgentChatCalloutAction[];
  /** Whether the card has a close button; default true. */
  readonly dismissible?: boolean;
}

interface AgentChatLabels {
  /** The accessible name of a callout's close button. */
  readonly calloutClose?: string;
}

interface AgentChatOptions {
  /** A callout button was clicked. Called synchronously inside the click, so the host still holds the user gesture (a file picker needs it). */
  readonly onCalloutAction?: (event: { readonly id: string; readonly actionId: string }) => void;
  /** The close button of a callout was clicked; the callout is already hidden. */
  readonly onCalloutDismiss?: (event: { readonly id: string }) => void;
}

interface AgentChatController {
  /** Shows a callout beside the assistant (one at a time); the same id updates it in place, another id replaces it. */
  showCallout(callout: AgentChatCallout): void;
  /** Hides the callout with this id, or whichever is shown when no id is given. */
  hideCallout(id?: string): void;
  getCalloutId(): string | undefined;
}
