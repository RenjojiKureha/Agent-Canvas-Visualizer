<script setup lang="ts">
import { computed } from "vue";
import type { GraphEdge, GraphNode } from "@acv/shared";

const props = defineProps<{
  nodes: GraphNode[];
  edges: GraphEdge[];
}>();

const positioned = computed(() => {
  const colWidth = 210;
  const rowHeight = 110;

  return props.nodes.map((n, i) => {
    const depth = n.parentId ? 1 : 0;
    return {
      ...n,
      x: 40 + depth * colWidth,
      y: 40 + i * rowHeight
    };
  });
});

function color(role: GraphNode["role"]) {
  if (role === "thought") return "#0f766e";
  if (role === "action") return "#1d4ed8";
  return "#7c3aed";
}
</script>

<template>
  <div style="width: 100%; overflow: auto">
    <svg width="980" height="620" style="border: 1px solid #d1d9e6; border-radius: 10px; background: #fbfdff">
      <g v-for="e in edges" :key="e.id">
        <line
          :x1="(positioned.find(n => n.id === e.from)?.x || 0) + 150"
          :y1="(positioned.find(n => n.id === e.from)?.y || 0) + 35"
          :x2="(positioned.find(n => n.id === e.to)?.x || 0)"
          :y2="(positioned.find(n => n.id === e.to)?.y || 0) + 35"
          stroke="#94a3b8"
          stroke-width="2"
        />
      </g>

      <g v-for="n in positioned" :key="n.id">
        <rect :x="n.x" :y="n.y" rx="10" ry="10" width="150" height="70" :fill="color(n.role)" opacity="0.95" />
        <text :x="n.x + 10" :y="n.y + 22" fill="white" font-size="12">{{ n.role }} · {{ n.status }}</text>
        <text :x="n.x + 10" :y="n.y + 44" fill="white" font-size="11">{{ n.content.slice(0, 20) }}</text>
      </g>
    </svg>
  </div>
</template>
