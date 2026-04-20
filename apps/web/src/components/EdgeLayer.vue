<script setup lang="ts">
import type { LayoutEdge } from "../composables/dagLayout";
import { edgePath, edgeStyle } from "../composables/dagLayout";

const props = defineProps<{ edges: LayoutEdge[] }>();

const emit = defineEmits<{ animated: [id: string] }>();
</script>

<template>
  <g v-for="e in props.edges" :key="e.id"
    class="dag-edge" :class="{ entering: e.isNew }"
    @animationend="emit('animated', e.id)"
  >
    <path :d="edgePath(e)"
      fill="none"
      :stroke="edgeStyle(e.kind).color"
      stroke-width="1.5"
      :stroke-dasharray="edgeStyle(e.kind).dash || 'none'"
      marker-end="url(#arrow)" />
    <text
      :x="(e.x1 + e.x2) / 2"
      :y="(e.y1 + e.y2) / 2 - 6"
      :fill="edgeStyle(e.kind).color"
      font-size="9" font-weight="600" text-anchor="middle"
      opacity="0.7">
      {{ edgeStyle(e.kind).label }}
    </text>
  </g>
</template>

<style scoped>
@keyframes edge-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}
.dag-edge.entering {
  animation: edge-enter 0.3s ease-out 0.1s both;
}
</style>
