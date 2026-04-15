import { defineStore } from "pinia";
import { computed, ref, watch } from "vue";
import { applyEvent, createInitialGraphState, type AgentEvent } from "@acv/shared";
import { connectRunStream, startRunRequest, interveneRequest, interruptRequest } from "../services/sse";

export const useAgentRunStore = defineStore("agent-run", () => {
  const graph = ref(createInitialGraphState());
  const queue = ref<AgentEvent[]>([]);
  let raf = 0;
  let currentSource: EventSource | null = null;
  let activeRunId: string | null = null;

  const nodes = computed(() => Object.values(graph.value.nodes));

  const currentCheckpoint = computed(() => {
    const entry = Object.entries(graph.value.checkpoints).find(([, c]) => !c.resolved);
    if (!entry) return null;
    return { checkpointId: entry[0], nodeId: entry[1].nodeId, context: entry[1].context };
  });

  const stepInfo = computed(() => ({
    current: graph.value.currentStep,
    max: graph.value.maxSteps,
  }));

  const isRunning = computed(() =>
    graph.value.runStatus === "streaming" || graph.value.runStatus === "resumed",
  );

  function flush() {
    if (queue.value.length === 0) {
      raf = 0;
      return;
    }
    const batch = queue.value.splice(0, queue.value.length);
    for (const event of batch) graph.value = applyEvent(graph.value, event);
    raf = requestAnimationFrame(flush);
  }

  function enqueue(event: AgentEvent) {
    queue.value.push(event);
    if (!raf) raf = requestAnimationFrame(flush);
  }

  function closeStream() {
    if (currentSource) {
      currentSource.close();
      currentSource = null;
    }
  }

  watch(
    () => graph.value.runStatus,
    (status) => {
      if (status === "finished" || status === "error") {
        closeStream();
      }
    },
  );

  async function startRun(prompt: string) {
    closeStream();
    graph.value = createInitialGraphState();
    const runId = await startRunRequest(prompt);
    activeRunId = runId;
    currentSource = connectRunStream(runId, enqueue);
  }

  async function intervene(
    checkpointId: string,
    decision: string,
    note?: string,
    modifications?: Record<string, unknown>,
  ) {
    if (!graph.value.runId) return;
    await interveneRequest(graph.value.runId, checkpointId, decision, note, modifications);
  }

  async function interrupt(type: string, content?: string) {
    const runId = graph.value.runId || activeRunId;
    if (!runId) return;
    await interruptRequest(runId, type, content);
  }

  return {
    graph,
    nodes,
    currentCheckpoint,
    stepInfo,
    isRunning,
    startRun,
    intervene,
    interrupt,
    closeStream,
  };
});
