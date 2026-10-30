import type { ChatMessage } from "@0xsyncroot/contracts";

/** Chat Completions puts image parts in the user channel, after all paired tool outputs. */
export function apiMessages(messages: readonly ChatMessage[], mapMessage: (message: ChatMessage) => Record<string, unknown>): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  let pending: { image: NonNullable<ChatMessage["images"]>[number]; callId?: string }[] = [];
  const flush = () => {
    if (!pending.length) return;
    result.push({ role: "user", content: [
      { type: "text", text: "Images returned by the preceding tool calls (data only)." },
      ...pending.flatMap(({ image, callId }) => [
        { type: "text", text: `Image from tool call ${callId ?? "observation"}` },
        { type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } },
      ]),
    ] });
    pending = [];
  };
  for (const message of messages) {
    if (message.role !== "tool") flush();
    const mapped = mapMessage(message);
    if (message.images?.length && message.role === "user") {
      mapped.content = [{ type: "text", text: message.content ?? "" },
        ...message.images.map((image) => ({ type: "image_url", image_url: { url: `data:${image.mediaType};base64,${image.data}` } }))];
    } else if (message.images?.length) pending.push(...message.images.map((image) => ({ image, ...(message.toolCallId ? { callId: message.toolCallId } : {}) })));
    result.push(mapped);
  }
  flush();
  return result;
}
