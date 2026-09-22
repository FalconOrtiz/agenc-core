export class McpAuthenticationError extends Error {
  constructor(message = "MCP authentication failed. Check the provider setup and try again.") {
    super(message);
    this.name = "McpAuthenticationError";
  }
}

export function isMcpAuthenticationError(error: unknown): boolean {
  return error instanceof McpAuthenticationError || (error instanceof Error && (
    error.name === "McpAuthenticationError" ||
    (error.cause !== undefined && error.cause !== error && isMcpAuthenticationError(error.cause))
  ));
}
