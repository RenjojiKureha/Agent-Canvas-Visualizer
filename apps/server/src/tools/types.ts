export interface ToolResult {
  success: boolean;
  output: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  requiresApproval: boolean;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}
