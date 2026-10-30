import type { JsonValue, ToolDefinition, ToolGroup } from "@0xsyncroot/contracts";
import { objectArguments, stringArgument } from "./arguments.js";

/** The tool that offers a tool group, and its argument naming the group: what core reads as the loader (`ToolGroupCatalog.loader`). */
export const TOOLS_LOAD_TOOL = Object.freeze({ toolId: "tools_load", argument: "group" });

/** A group's purpose as the loader lists it: the words before its first elaboration, enough to pick a group by. */
function shortPurpose(purpose: string): string {
  const end = purpose.search(/[:;(]/u);
  return (end < 0 ? purpose : purpose.slice(0, end)).trim();
}

/**
 * Offers the tools of one group for the rest of the turn. A turn is offered only the groups its request may need; this is
 * the way to the others, so a tool left out is never out of reach. It changes nothing outside the turn and returns data:
 * the group and its tools, which core cuts to the ones the turn's own surface holds (`loaderOnSurface`).
 */
export function createToolsLoadTool(groups: readonly ToolGroup[]): ToolDefinition {
  const byId = new Map(groups.map((group) => [group.id, group]));
  return {
    id: TOOLS_LOAD_TOOL.toolId, version: "1.0.0",
    description: "Offer one tool group for the rest of this turn. Call it when the work needs a tool that is not offered, or when a refused call names its group. Groups: "
      + groups.map((group) => `${group.id}: ${shortPurpose(group.purpose)}`).join(" | "),
    inputSchema: {
      type: "object", additionalProperties: false, required: [TOOLS_LOAD_TOOL.argument],
      properties: { [TOOLS_LOAD_TOOL.argument]: { type: "string", enum: groups.map((group) => group.id) } },
    },
    outputSchema: {},
    // Offering a tool grants nothing: each call is still authorized by the tool policy as any other.
    requiredPermissions: [], sideEffect: "none", timeoutMs: 500,
    execute: async (invocation) => {
      const groupId = stringArgument(objectArguments(invocation.arguments), TOOLS_LOAD_TOOL.argument, 200);
      const group = byId.get(groupId);
      return (group ? { group: group.id, tools: [...group.toolIds] } : { error: "group_not_found", groups: [...byId.keys()] }) as JsonValue;
    },
  };
}
