export function materiaColorClass(color: string): string {
  if (!color) return '';
  // Existing saved configs may still contain Tailwind gradient stops; keep them renderable as migration compatibility.
  return color.includes('from-') ? `bg-gradient-to-br ${color}` : color;
}

export function formatElapsed(startedAt?: number, now = Date.now()) {
  if (!startedAt) return '—';
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

export function formatTime(timestamp?: number) {
  return timestamp ? new Date(timestamp).toLocaleTimeString() : 'live';
}
