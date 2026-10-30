import type { JsonValue, ToolDefinition, ToolGroupCatalog } from "@0xsyncroot/contracts";

/**
 * The turn's tools with the loader's result cut to the surface: the loader lists a group's catalog, and a tool the turn
 * does not hold (a connector down, a policy that removed it) is one the model could call only to be refused. Only the
 * result's `tools` list is read; anything else the loader returns passes through.
 */
export function loaderOnSurface(tools: readonly ToolDefinition[], catalog: ToolGroupCatalog | undefined): readonly ToolDefinition[] {
  if (!catalog) return tools;
  const present = new Set(tools.map((tool) => tool.id));
  return tools.map((tool): ToolDefinition => tool.id !== catalog.loader.toolId ? tool : {
    ...tool,
    execute: async (invocation, signal) => {
      const result = await tool.execute(invocation, signal);
      const listed = result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, JsonValue>).tools : undefined;
      return Array.isArray(listed)
        ? { ...(result as Record<string, JsonValue>), tools: listed.filter((toolId) => typeof toolId === "string" && present.has(toolId)) }
        : result;
    },
  });
}
