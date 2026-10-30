/**
 * The budgets one turn spends: model steps, tool calls, elapsed time, and how long any single
 * model call may take.
 *
 * They live together because they are only ever right together. A deployment that raises the
 * step cap and leaves the tool-call cap alone is still cut by the one it did not look at.
 *
 * Elapsed time is not a length for the job. `turnTimeoutMs` is how long a turn may go without a
 * step or a tool call, and `agentLlmAttemptTimeoutMs` is how long a model call may go without a
 * stream event. Both restart when something arrives. Raising either number so a long read can
 * finish does not help: a read that is still producing steps never meets the clock. The number
 * catches a hung call. Claude Code's stream-idle watchdog and Cursor's agent loop are the same
 * shape — the loop runs until the model stops, and the clock only fires on silence.
 *
 * Each is bounded at both ends. Zero stops a turn before its first call; unbounded lets one turn
 * spend a session's worth of an upstream API, or hold its lease, on its own.
 */

/** @internal The parsed, bounded budgets. Field names match the core's own agent options. */
export interface AgentBudgets {
  readonly agentMaxSteps: number;
  readonly agentMaxToolCalls: number;
  readonly agentTurnTimeoutMs: number;
  readonly agentLlmAttemptTimeoutMs: number;
  /** The longest silence before a model call is sent once more (the learned time is never above it); 0 = never. See AGENTIC_AGENT_LLM_HEDGE_AFTER_MS. */
  readonly agentLlmHedgeAfterMs: number;
  /** Rounds of policy reads one step may run before its model call. See AGENTIC_AGENT_MAX_OBSERVATION_ROUNDS. */
  readonly agentMaxObservationRounds: number;
  /** Text one model attempt may stream before it is cut and generated again. See AGENTIC_AGENT_MAX_ANSWER_CHARS. */
  readonly agentMaxAnswerChars: number;
  /** How long a turn's open waits for the memory search before going on without memory. See AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS. */
  readonly agentMemoryContextTimeoutMs: number;
}

export function readAgentBudgets(
  env: Record<string, string | undefined>,
  finiteSetting: (name: string, value: string | undefined, fallback: number) => number,
): AgentBudgets {
  const bounded = (low: number, high: number, value: number): number => Math.max(low, Math.min(high, Math.round(value)));
  return {
    // The ceiling was 64, and a product whose one turn is a forty-six-sheet dossier read a page at
    // a time needs more steps than that to finish what it was asked: a cap that ends the work is
    // not a safety margin. The default is unchanged; a product that needs the room asks for it.
    agentMaxSteps: bounded(1, 256, finiteSetting("AGENTIC_AGENT_MAX_STEPS", env.AGENTIC_AGENT_MAX_STEPS, 20)),
    // One fixed ceiling per turn. Each configured ceiling equals the former 4× growth limit of the ceiling it replaced
    // (default 24 → 96, EXAMPLE 400 → 1600), so no progressing turn gets less room than it had.
    agentMaxToolCalls: bounded(1, 2048, finiteSetting("AGENTIC_AGENT_MAX_TOOL_CALLS", env.AGENTIC_AGENT_MAX_TOOL_CALLS, 96)),
    agentTurnTimeoutMs: bounded(10_000, 3_600_000, finiteSetting("AGENTIC_AGENT_TURN_TIMEOUT_MS", env.AGENTIC_AGENT_TURN_TIMEOUT_MS, 300_000)),
    agentLlmAttemptTimeoutMs: bounded(5_000, 600_000, finiteSetting("AGENTIC_AGENT_LLM_ATTEMPT_TIMEOUT_MS", env.AGENTIC_AGENT_LLM_ATTEMPT_TIMEOUT_MS, 45_000)),
    // The cap of the learned wait (core FirstEventModel): the wait itself until a model has five samples. 0 turns the second
    // call off; a large value does not, once the wait is learned. Only ever made for a stream that shows progress (core AttemptRace).
    agentLlmHedgeAfterMs: bounded(0, 600_000, finiteSetting("AGENTIC_AGENT_LLM_HEDGE_AFTER_MS", env.AGENTIC_AGENT_LLM_HEDGE_AFTER_MS, 20_000)),
    // One round is the core default: a policy's reads run once and the model is called. A product whose policy
    // pages through a source before the model reads it asks for more; each round still counts against the tool-call cap.
    agentMaxObservationRounds: bounded(1, 16, finiteSetting("AGENTIC_AGENT_MAX_OBSERVATION_ROUNDS", env.AGENTIC_AGENT_MAX_OBSERVATION_ROUNDS, 1)),
    // A model with no output ceiling can loop to its own token limit (core AnswerBound cuts a loop much earlier). The
    // default is the core's backstop; a product sizes its own from its longest answers and what its delivery can carry.
    agentMaxAnswerChars: bounded(4_000, 1_000_000, finiteSetting("AGENTIC_AGENT_MAX_ANSWER_CHARS", env.AGENTIC_AGENT_MAX_ANSWER_CHARS, 100_000)),
    // Memory recall at turn open is advisory: past this bound the turn goes on without it (core openWaits). The memory_search tool's own limit is 2 s.
    agentMemoryContextTimeoutMs: bounded(500, 60_000, finiteSetting("AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS", env.AGENTIC_AGENT_MEMORY_CONTEXT_TIMEOUT_MS, 5_000)),
  };
}
