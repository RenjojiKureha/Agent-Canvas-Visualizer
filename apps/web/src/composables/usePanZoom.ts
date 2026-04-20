import { computed, ref, type Ref } from "vue";

const MIN_SCALE = 0.15;
const MAX_SCALE = 3;

export function usePanZoom(containerRef: Ref<HTMLElement | null>) {
  const scale = ref(1);
  const panX = ref(0);
  const panY = ref(0);
  const isPanning = ref(false);
  const panStart = ref({ x: 0, y: 0 });

  const transformStyle = computed(
    () => `transform: translate(${panX.value}px, ${panY.value}px) scale(${scale.value}); transform-origin: 0 0;`,
  );

  const zoomPercent = computed(() => Math.round(scale.value * 100));

  function zoomIn() {
    scale.value = Math.min(MAX_SCALE, scale.value * 1.25);
  }

  function zoomOut() {
    scale.value = Math.max(MIN_SCALE, scale.value / 1.25);
  }

  function zoomReset() {
    scale.value = 1;
    panX.value = 0;
    panY.value = 0;
  }

  function zoomFitTo(svgWidth: number, svgHeight: number) {
    const container = containerRef.value;
    if (!container || svgWidth <= 0 || svgHeight <= 0) return;
    const rect = container.getBoundingClientRect();
    const sx = rect.width / svgWidth;
    const sy = rect.height / svgHeight;
    scale.value = Math.min(sx, sy, 1) * 0.95;
    panX.value = (rect.width - svgWidth * scale.value) / 2;
    panY.value = (rect.height - svgHeight * scale.value) / 2;
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const container = containerRef.value;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.value * factor));

    panX.value = mouseX - (mouseX - panX.value) * (newScale / scale.value);
    panY.value = mouseY - (mouseY - panY.value) * (newScale / scale.value);
    scale.value = newScale;
  }

  function onPointerDown(e: PointerEvent) {
    const target = e.target as Element;
    if (
      e.button === 1 ||
      (e.button === 0 && target?.closest?.(".dag-svg") && !target?.closest?.(".dag-node"))
    ) {
      isPanning.value = true;
      panStart.value = { x: e.clientX - panX.value, y: e.clientY - panY.value };
      (e.currentTarget as HTMLElement)?.setPointerCapture(e.pointerId);
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!isPanning.value) return;
    panX.value = e.clientX - panStart.value.x;
    panY.value = e.clientY - panStart.value.y;
  }

  function onPointerUp() {
    isPanning.value = false;
  }

  return {
    scale,
    panX,
    panY,
    isPanning,
    transformStyle,
    zoomPercent,
    zoomIn,
    zoomOut,
    zoomReset,
    zoomFitTo,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}
