import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { createWriteFileTool } from "./writeFile";

describe("writeFile tool", () => {
  let sandbox: string;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "acv-wf-"));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("writes file inside sandbox and reports success", async () => {
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute({ path: "hello.txt", content: "hi" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello.txt");
    const onDisk = await readFile(join(sandbox, "hello.txt"), "utf-8");
    expect(onDisk).toBe("hi");
  });

  it("creates parent directories for nested paths", async () => {
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute({ path: "a/b/c.txt", content: "deep" });
    expect(result.success).toBe(true);
    const onDisk = await readFile(join(sandbox, "a", "b", "c.txt"), "utf-8");
    expect(onDisk).toBe("deep");
  });

  it("rejects absolute paths outside the sandbox", async () => {
    const tool = createWriteFileTool(sandbox);
    const outside = sep === "\\" ? "C:\\Windows\\acv-escape.txt" : "/tmp/acv-escape.txt";
    const result = await tool.execute({ path: outside, content: "nope" });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/escapes sandbox root/);
  });

  it("rejects parent-traversal paths", async () => {
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute({ path: "../../../etc/passwd", content: "nope" });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/escapes sandbox root/);
  });

  it("advertises requiresApproval=true", () => {
    const tool = createWriteFileTool(sandbox);
    expect(tool.requiresApproval).toBe(true);
    expect(tool.name).toBe("write_file");
  });

  it("overwrites existing files", async () => {
    await mkdir(sandbox, { recursive: true });
    await writeFile(join(sandbox, "same.txt"), "old");
    const tool = createWriteFileTool(sandbox);
    const result = await tool.execute({ path: "same.txt", content: "new" });
    expect(result.success).toBe(true);
    const onDisk = await readFile(join(sandbox, "same.txt"), "utf-8");
    expect(onDisk).toBe("new");
  });
});
