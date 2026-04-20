import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Writable } from "node:stream";
import type { ServerResponse } from "node:http";
import { RunManager } from "./runManager";

class FakeResponse extends Writable {
  public chunks: string[] = [];
  public closed = false;
  public writableEnded = false;
  public destroyed = false;

  _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void) {
    this.chunks.push(chunk.toString());
    cb();
  }

  emitClose() {
    this.closed = true;
    this.emit("close");
  }

  asServerResponse(): ServerResponse {
    return this as unknown as ServerResponse;
  }
}

describe("RunManager", () => {
  let originalProvider: string | undefined;

  beforeEach(() => {
    originalProvider = process.env.AGENT_PROVIDER;
    process.env.AGENT_PROVIDER = "api";
    // api provider requires an API key in LlmClient constructor path; unset to test gate
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalProvider === undefined) delete process.env.AGENT_PROVIDER;
    else process.env.AGENT_PROVIDER = originalProvider;
  });

  describe("intervene on missing run", () => {
    it("returns false for unknown runId", () => {
      const mgr = new RunManager();
      expect(mgr.intervene("nope", "cp1", "approve")).toBe(false);
      mgr.destroy();
    });
  });

  describe("interrupt validation", () => {
    it("rejects unknown interrupt type", () => {
      const mgr = new RunManager();
      mgr.addClient("r1", new FakeResponse().asServerResponse());
      expect(mgr.interrupt("r1", "bogus_type")).toBe(false);
      mgr.destroy();
    });

    it("returns false for unknown runId", () => {
      const mgr = new RunManager();
      expect(mgr.interrupt("nope", "abort")).toBe(false);
      mgr.destroy();
    });

    it("accepts known interrupt types", () => {
      const mgr = new RunManager();
      mgr.addClient("r1", new FakeResponse().asServerResponse());
      expect(mgr.interrupt("r1", "abort")).toBe(true);
      expect(mgr.interrupt("r1", "pause")).toBe(true);
      expect(mgr.interrupt("r1", "inject_message", "msg")).toBe(true);
      mgr.destroy();
    });
  });

  describe("SSE replay", () => {
    it("replays events with seq > lastSeq when client connects late", () => {
      const mgr = new RunManager();
      // Seed events by using internals via addClient before/after emits.
      // Use the public emit path: trigger via interrupt (no-op) to avoid real loop.
      // We manually inject events via the SSE replay behaviour: send two fake events.
      const res = new FakeResponse();
      mgr.addClient("r1", res.asServerResponse());
      // Directly access internal via cast to push events
      type RunManagerInternals = {
        emitEvent: (runId: string, event: { type: string }) => void;
      };
      (mgr as unknown as RunManagerInternals).emitEvent("r1", { type: "run_started" });
      (mgr as unknown as RunManagerInternals).emitEvent("r1", { type: "loop_step", step: 1, maxSteps: 10 } as { type: string });

      // New client resuming from seq 1 should get only seq 2.
      const res2 = new FakeResponse();
      mgr.addClient("r1", res2.asServerResponse(), 1);
      const joined = res2.chunks.join("");
      expect(joined).toContain("id: 2");
      expect(joined).not.toContain("id: 1");
      mgr.destroy();
    });
  });

  describe("removeClient", () => {
    it("is a no-op for unknown run", () => {
      const mgr = new RunManager();
      expect(() =>
        mgr.removeClient("nope", new FakeResponse().asServerResponse()),
      ).not.toThrow();
      mgr.destroy();
    });
  });

  describe("getEvents", () => {
    it("returns [] for unknown runId", () => {
      const mgr = new RunManager();
      expect(mgr.getEvents("nope")).toEqual([]);
      mgr.destroy();
    });
  });
});
