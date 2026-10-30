import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { errorMessage } from "./email-utils.ts";

export function toolResult(value: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  };
}

/** JSON metadata first, then one image block per image, in the same order. */
export function toolResultWithImages(
  value: unknown,
  images: ReadonlyArray<{ mimeType: string; data: Buffer }>,
): CallToolResult {
  return {
    content: [
      { type: "text", text: JSON.stringify(value, null, 2) },
      ...images.map(({ mimeType, data }) => ({
        type: "image" as const,
        mimeType,
        data: data.toString("base64"),
      })),
    ],
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
