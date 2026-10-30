import type { ToolAuthorizationInput, ToolDefinition, ToolDiscoveryContext, ToolExecutionPolicy, ToolPolicyDecision } from "@0xsyncroot/contracts";

/**
 * Keeps the whole result of the named tools in the runtime's spool, even when it fits the context.
 *
 * A retained result is one `calculate` can take as input and `read_result` can page through by
 * id. Readers of source data (a document's table, a spreadsheet page) are the ones worth keeping:
 * a figure the answer states is then computed from the source itself, not copied by the model.
 */
export class RetainedResultsToolPolicy implements ToolExecutionPolicy {
  readonly #retained: ReadonlySet<string>;

  constructor(private readonly upstream: ToolExecutionPolicy, toolIds: Iterable<string>) {
    this.#retained = new Set(toolIds);
  }

  async discover(tools: readonly ToolDefinition[], context: ToolDiscoveryContext): Promise<readonly ToolDefinition[]> {
    return (await this.upstream.discover(tools, context)).map((tool) => this.#retained.has(tool.id) ? { ...tool, retainResult: true } : tool);
  }

  authorize(input: ToolAuthorizationInput): Promise<ToolPolicyDecision> {
    return this.upstream.authorize(input);
  }
}
