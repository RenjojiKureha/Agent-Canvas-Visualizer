import { defineStore } from "pinia";
import { computed, ref } from "vue";
import { applyEvent, createInitialGraphState, type AgentEvent } from "@acv/shared";
import { connectRunStream, startRunRequest, interveneRequest } from "../services/sse";

export const useAgentRunStore = defineStore("agent-run", () => {
  const graph = ref(createInitialGraphState());
  const queue = ref<AgentEvent[]>([]);
  let raf = 0;

  const nodes = computed(() => Object.values(graph.value.nodes));

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

  async function startRun(prompt: string) {
    graph.value = createInitialGraphState();
    const runId = await startRunRequest(prompt);
    connectRunStream(runId, enqueue);
  }

  async function intervene(checkpointId: string, decision: string) {
    if (!graph.value.runId) return;
    await interveneRequest(graph.value.runId, checkpointId, decision);
  }

  return {
    graph,
    nodes,
    startRun,
    intervene
  };
});
