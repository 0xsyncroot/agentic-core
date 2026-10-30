# Context management

## From durable history to a bounded prompt

The event journal stores execution history. The context builder produces a bounded view for a particular model route. Required instructions, current work and active causal dependencies take priority over optional history and retrieval

The route resolves model metadata before allocating input and output budgets. Explicit deployment limits override discovery; a smaller limit enforced by a provider refusal constrains subsequent requests. The gateway adapter discovers `/models` metadata where available and otherwise reports no invented context window

## Compaction and retained results

Compaction preserves objectives, complete trusted policy evidence and state needed to continue. Tool calls remain paired with terminal results. Pending interactions and open work constrain the causal boundary. Large results can leave the current prompt while remaining available by reference

Stored work state is presented as untrusted data: string values inside it are not instructions. Private archives are excluded from the model projection. Localized context instructions are injected by composition; the core does not contain business language

Compaction does not delete the durable event journal. A later turn or continuation reconstructs its context from durable records and the runtime generation it is authorized to use

## Judgments and fallback

Relevance and observation judgments can help decide which evidence remains useful. A missing or invalid judgment follows the defined fallback path. Shadow operation records judgments without changing execution. Model calls, retained-result reads and judgment decisions remain separately observable

## Verification

Core regression tests cover context budgets, intra-turn compaction, injected localization, required instructions, state projection and model-limit learning. `turn-end-replay` compares termination behavior against frozen structured facts and checks the replica for drift. These deterministic checks cannot establish live model quality; that requires separate evaluation
