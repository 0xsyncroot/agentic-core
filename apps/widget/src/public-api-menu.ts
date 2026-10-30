/**
 * On/off settings the host adds to the header "…" menu, and a badge beside the agent name. The
 * widget draws the switch and the optional confirmation; the host owns the words and the state.
 * These merge into the declarations of public-api.ts.
 */

/** Asked inline in the panel before a toggle is switched on; switching off never asks. */
interface AgentChatMenuToggleConfirm {
  readonly title: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
}

interface AgentChatMenuToggle {
  /** Stable key for setMenuToggle and onMenuToggle. */
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** When present, switching this toggle on first asks the user to confirm. */
  readonly confirmOn?: AgentChatMenuToggleConfirm;
}

interface AgentChatMenuToggleEvent {
  readonly id: string;
  /** The state the user asked for. */
  readonly checked: boolean;
  readonly sessionId: string;
}

interface AgentChatOptions {
  readonly menuToggles?: readonly AgentChatMenuToggle[];
  /** Resolve true to keep the new state; false or a throw puts the toggle back as it was. */
  readonly onMenuToggle?: (event: AgentChatMenuToggleEvent) => boolean | Promise<boolean>;
}

interface AgentChatController {
  /** Sets a declared toggle without calling onMenuToggle; `visible: false` hides it. Unknown ids are ignored. */
  setMenuToggle(id: string, state: { readonly checked?: boolean; readonly disabled?: boolean; readonly visible?: boolean }): void;
  /** Shows a short label beside the agent name (the same badge as the `badge` option); null restores the option's value. */
  setBadge(label: string | null, title?: string): void;
}
