import { writeFile, mkdir } from "node:fs/promises";
import { resolve, relative, dirname } from "node:path";
import type { Tool } from "./types";

export function createWriteFileTool(sandboxRoot: string): Tool {
  return {
    name: "write_file",
    description: "Write content to a file within the project directory. Creates parent directories if needed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path to the file from project root" },
        content: { type: "string", description: "The content to write to the file" },
      },
      required: ["path", "content"],
    },
    requiresApproval: true,
    async execute(args) {
      const filePath = resolve(sandboxRoot, String(args.path));
      const rel = relative(sandboxRoot, filePath);
      if (rel.startsWith("..") || resolve(sandboxRoot, rel) !== filePath) {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, String(args.content), "utf-8");
        return { success: true, output: `Written ${rel} (${String(args.content).length} chars)` };
      } catch (err) {
        return { success: false, output: `Failed to write file: ${(err as Error).message}` };
      }
    },
  };
}
