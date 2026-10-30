import type { ToolDefinition } from "@0xsyncroot/contracts";
import { ArithmeticParser } from "./arithmetic-parser.js";
import { objectArguments, stringArgument } from "./arguments.js";

/**
 * `arithmetic: false` leaves out the expression calculator, for a runtime that mounts a calculation
 * tool of its own under the same name (one that computes from stored results instead of numbers the
 * model types in).
 */
export function createUtilityTools(options: { readonly arithmetic?: boolean } = {}): readonly ToolDefinition[] {
  return [
    ...(options.arithmetic === false ? [] : [{
      id: "calculate", version: "1.0.0", computes: true,
      description: "Evaluate a bounded arithmetic expression offline. Supports +, -, *, /, %, ^ and parentheses; never executes code.",
      inputSchema: { type: "object", properties: { expression: { type: "string", maxLength: 200 } }, required: ["expression"], additionalProperties: false },
      outputSchema: {},
      requiredPermissions: ["utility.calculate"], sideEffect: "none", timeoutMs: 500,
      execute: async (invocation) => {
        const expression = stringArgument(objectArguments(invocation.arguments), "expression", 200);
        return { expression, result: new ArithmeticParser(expression).parse() };
      },
    } satisfies ToolDefinition]),
    {
      id: "current_time", version: "1.0.0", description: "Return the current UTC timestamp from the trusted runtime clock.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      outputSchema: {},
      requiredPermissions: ["utility.time"], sideEffect: "none", timeoutMs: 500,
      execute: async () => ({ utc: new Date().toISOString(), timezone: "UTC" }),
    },
  ];
}
