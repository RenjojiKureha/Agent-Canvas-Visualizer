import { readdir, stat } from "node:fs/promises";
import { resolve, relative, join } from "node:path";
import type { Tool } from "./types";

export function createListFilesTool(sandboxRoot: string): Tool {
  return {
    name: "list_files",
    description: "List files and directories within a path in the project. Returns a tree up to 2 levels deep.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative directory path from project root. Defaults to '.'." },
      },
      required: [],
    },
    requiresApproval: false,
    async execute(args) {
      const dirPath = resolve(sandboxRoot, String(args.path || "."));
      const rel = relative(sandboxRoot, dirPath);
      if (rel.startsWith("..") && rel !== "") {
        return { success: false, output: "Path escapes sandbox root" };
      }
      try {
        const lines = await listDir(dirPath, sandboxRoot, 0, 2);
        return { success: true, output: lines.join("\n") || "(empty directory)" };
      } catch (err) {
        return { success: false, output: `Failed to list: ${(err as Error).message}` };
      }
    },
  };
}

async function listDir(dir: string, root: string, depth: number, maxDepth: number): Promise<string[]> {
  if (depth >= maxDepth) return [];
  const entries = await readdir(dir);
  const lines: string[] = [];
  const indent = "  ".repeat(depth);

  const filtered = entries.filter((e) => !["node_modules", ".git", "dist", ".cache"].includes(e));
  filtered.sort();

  for (const entry of filtered) {
    const fullPath = join(dir, entry);
    try {
      const s = await stat(fullPath);
      if (s.isDirectory()) {
        lines.push(`${indent}${entry}/`);
        const sub = await listDir(fullPath, root, depth + 1, maxDepth);
        lines.push(...sub);
      } else {
        lines.push(`${indent}${entry}`);
      }
    } catch {
      lines.push(`${indent}${entry} (unreadable)`);
    }
  }
  return lines;
}
