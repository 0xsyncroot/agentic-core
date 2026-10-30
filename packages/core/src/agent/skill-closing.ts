import type { SessionEvent, SystemPromptProvider, SystemPromptTurn } from "@0xsyncroot/contracts";

/**
 * The skills loaded in the task: a successful call of a provider's skill loader naming the skill, in one of the task's turns
 * (the request that began it and every turn resuming it after an approval or an answer). A skill loaded for an earlier
 * request is not this one's procedure.
 */
export function taskSkillLoads(events: readonly SessionEvent[], taskTurnIds: readonly string[], loader: { readonly toolId: string; readonly argument: string }): ReadonlySet<string> {
  const task = new Set(taskTurnIds);
  const payload = (event: SessionEvent) => event.payload as Record<string, unknown>;
  const intents = new Map(events.filter((event) => event.type === "tool/intent" && task.has(event.turnId ?? "")).map((event) => [payload(event).callId, payload(event)]));
  const loaded = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool/result" || !task.has(event.turnId ?? "")) continue;
    const result = payload(event);
    if (result.toolId !== loader.toolId || result.state !== "succeeded") continue;
    try {
      const skillId = (JSON.parse(String(intents.get(result.callId)?.arguments ?? "")) as Record<string, unknown>)[loader.argument];
      if (typeof skillId === "string") loaded.add(skillId);
    } catch { /* Arguments that are not JSON named no skill. */ }
  }
  return loaded;
}

/**
 * The closing lines of the skills in effect for the step about to run (`SystemPromptProvider.skillClosings`), in prompt order.
 *
 * Read on every step, not once a turn: the line belongs at the end of the request, which changes every step anyway, so a
 * skill loaded during the turn adds its line from the next step without touching the cached prefix. A skill's rule read
 * last holds where the same rule earlier in the prompt is lost (docs/incidents/2026-10-14-core-skill-closing-line.md).
 */
export function skillClosingLines(prompts: readonly SystemPromptProvider[], turn: SystemPromptTurn, events: readonly SessionEvent[], taskTurnIds: readonly string[]): readonly string[] {
  const providers = prompts.filter((prompt) => prompt.skillClosings);
  if (providers.length === 0) return [];
  const loader = prompts.find((prompt) => prompt.skillLoader)?.skillLoader;
  const loadedSkills = loader ? taskSkillLoads(events, taskTurnIds, loader) : new Set<string>();
  return [...new Set(providers.flatMap((prompt) => prompt.skillClosings!({ ...turn, loadedSkills }).map((line) => line.trim()).filter(Boolean)))];
}
