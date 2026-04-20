<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted, nextTick, toRef } from "vue";
import type { GraphEdge, GraphNode } from "@acv/shared";
import { useLayout } from "../composables/useLayout";
import { usePanZoom } from "../composables/usePanZoom";
import NodeCard from "./NodeCard.vue";
import EdgeLayer from "./EdgeLayer.vue";
import NodeDetailPanel from "./NodeDetailPanel.vue";

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  decisions?: Record<string, { decision: string }>;
}>();

const selectedNodeId = ref<string | null>(null);
const dagContainerRef = ref<HTMLElement | null>(null);
const knownNodeIds = ref(new Set<string>());
const knownEdgeIds = ref(new Set<string>());

const { layout } = useLayout(
  toRef(props, "nodes"),
  toRef(props, "edges"),
  knownNodeIds,
  knownEdgeIds,
);

const {
  scale, panY, isPanning, transformStyle, zoomPercent,
  zoomIn, zoomOut, zoomReset, zoomFitTo,
  onWheel, onPointerDown, onPointerMove, onPointerUp,
} = usePanZoom(dagContainerRef);

function zoomFit() {
  zoomFitTo(layout.value.svgWidth, layout.value.svgHeight);
}

const selectedNode = computed(() => {
  if (!selectedNodeId.value) return null;
  return props.nodes.find((n) => n.id === selectedNodeId.value) ?? null;
});

function selectNode(id: string) {
  selectedNodeId.value = selectedNodeId.value === id ? null : id;
}

function closeDetail() {
  selectedNodeId.value = null;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape" && selectedNodeId.value) closeDetail();
}

onMounted(() => document.addEventListener("keydown", onKeyDown));
onUnmounted(() => document.removeEventListener("keydown", onKeyDown));

const prevNodeCount = ref(0);
watch(
  () => props.nodes.length,
  (count) => {
    if (count > prevNodeCount.value && layout.value.nodes.length > 0) {
      nextTick(() => {
        const lastNode = layout.value.nodes[layout.value.nodes.length - 1];
        const container = dagContainerRef.value;
        if (!lastNode || !container) return;
        const rect = container.getBoundingClientRect();
        const nodeBottom = lastNode.y + lastNode.height;
        const visibleBottom = (-panY.value + rect.height) / scale.value;
        if (nodeBottom > visibleBottom) {
          panY.value = -(nodeBottom * scale.value - rect.height + 40);
        }
      });
    }
    prevNodeCount.value = count;
  },
);

function onNodeAnimated(id: string) { knownNodeIds.value.add(id); }
function onEdgeAnimated(id: string) { knownEdgeIds.value.add(id); }
</script>

<template>
  <div class="dag-wrapper">
    <div
      ref="dagContainerRef"
      class="dag-viewport"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      :class="{ panning: isPanning }"
    >
      <div v-if="props.nodes.length === 0" class="dag-empty">
        <div class="dag-empty-content">
          <div class="dag-empty-icon">&#9697;</div>
          <div class="dag-empty-text">Start an agent run to see the execution graph here.</div>
          <div class="dag-empty-hint">Configure prompt and project path in the sidebar, then click Start Run.</div>
        </div>
      </div>
      <div v-else class="dag-transform" :style="transformStyle">
        <svg :width="layout.svgWidth" :height="layout.svgHeight" class="dag-svg" overflow="visible">
          <defs>
            <filter id="node-shadow" x="-6%" y="-6%" width="112%" height="120%">
              <feDropShadow dx="0" dy="2" stdDeviation="4" flood-opacity="0.07" />
            </filter>
            <filter id="node-shadow-hover" x="-6%" y="-6%" width="112%" height="120%">
              <feDropShadow dx="0" dy="4" stdDeviation="8" flood-opacity="0.12" />
            </filter>
            <marker id="arrow" viewBox="0 0 10 6" refX="10" refY="3"
              markerWidth="8" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 3 L 0 6 z" fill="#94a3b8" />
            </marker>
            <clipPath v-for="n in layout.nodes" :key="`clip-${n.id}`" :id="`clip-${n.id}`">
              <rect x="0" y="0" rx="10" ry="10" :width="n.width" :height="n.height" />
            </clipPath>
          </defs>

          <EdgeLayer :edges="layout.edges" @animated="onEdgeAnimated" />

          <NodeCard
            v-for="n in layout.nodes"
            :key="n.id"
            :node="n"
            :selected="selectedNodeId === n.id"
            :decision="props.decisions?.[n.id]?.decision"
            @select="selectNode"
            @animated="onNodeAnimated"
          />
        </svg>
      </div>
    </div>

    <div v-if="props.nodes.length > 0" class="zoom-controls">
      <button @click="zoomIn" title="Zoom in">+</button>
      <div class="zoom-label">{{ zoomPercent }}%</div>
      <button @click="zoomOut" title="Zoom out">&minus;</button>
      <button @click="zoomReset" title="Reset zoom" style="font-size:12px">1:1</button>
      <button @click="zoomFit" title="Fit to view" style="font-size:11px">Fit</button>
    </div>

    <transition name="slide">
      <NodeDetailPanel v-if="selectedNode" :node="selectedNode" @close="closeDetail" />
    </transition>
  </div>
</template>

<style scoped>
.dag-wrapper {
  flex: 1;
  display: flex;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

.dag-viewport {
  flex: 1;
  overflow: hidden;
  cursor: grab;
  position: relative;
  user-select: none;
  background:
    radial-gradient(circle, #e5e7eb 1px, transparent 1px);
  background-size: 24px 24px;
  background-color: #f8fafc;
}

.dag-viewport.panning { cursor: grabbing; }

.dag-transform { will-change: transform; }

.dag-svg { display: block; }

.dag-node:hover .node-bg { filter: url(#node-shadow-hover); }

.slide-enter-active, .slide-leave-active { transition: transform 0.25s ease, opacity 0.25s ease; }
.slide-enter-from, .slide-leave-to { opacity: 0; transform: translateX(100%); }

.dag-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  position: absolute;
  inset: 0;
}
.dag-empty-content {
  text-align: center;
  color: #9ca3af;
}
.dag-empty-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.4;
}
.dag-empty-text {
  font-size: 15px;
  margin-bottom: 6px;
}
.dag-empty-hint {
  font-size: 12px;
  opacity: 0.7;
}
</style>
