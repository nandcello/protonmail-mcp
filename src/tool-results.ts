import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "./email-utils.ts";

export function toolResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

function toolFailure(error: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: errorMessage(error) }],
    isError: true,
  };
}

export async function withToolErrorHandling(
  operation: () => CallToolResult | Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return toolFailure(error);
  }
}
