import { readFile } from "node:fs/promises";
import { resolve, relative } from "node:path";
import type { Tool } from "./types";

export function createReadFileTool(sandboxRoot: string): Tool {
  return {
    name: "read_file",
    description: "Read the content of a file within the project directory.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from project root" },
      },
      required: ["path"],
    },
    requiresApproval: false,
    async execute(args) {
      const filePath = resolve(sandboxRoot, String(args.path));
      const rel = relative(sandboxRoot, filePath);
      if (rel.startsWith("..") || resolve(sandboxRoot, rel) !== filePath) {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        const content = await readFile(filePath, "utf-8");
        const truncated = content.length > 10000 ? content.slice(0, 10000) + "\n...(truncated)" : content;
        return { success: true, output: truncated };
      } catch (err) {
        return { success: false, output: `Failed to read file: ${(err as Error).message}` };
      }
    },
  };
}
