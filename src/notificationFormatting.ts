import { parseCanonicalSocketId } from "./socketIds.js";

export interface MateriaNotificationDisplay {
  materiaName: string;
  socketOrdinal?: number;
  label: string;
}

export function compactSocketOrdinal(socketId: string | undefined): number | undefined {
  return socketId ? parseCanonicalSocketId(socketId)?.ordinal : undefined;
}

export function formatMateriaNotificationDisplay(materiaName: string | undefined, socketId?: string): MateriaNotificationDisplay {
  const nodeOrdinal = compactSocketOrdinal(socketId);
  const fallback = "materia";
  let displayName = materiaName?.trim() || fallback;
  let suffixOrdinal: number | undefined;

  if (socketId && displayName.endsWith(` ${socketId}`)) {
    displayName = displayName.slice(0, -(` ${socketId}`).length).trim() || fallback;
  } else {
    const suffix = /\s+(Socket-[1-9]\d*)$/.exec(displayName);
    if (suffix) {
      suffixOrdinal = compactSocketOrdinal(suffix[1]);
      displayName = displayName.slice(0, suffix.index).trim() || fallback;
    }
  }

  const socketOrdinal = nodeOrdinal ?? suffixOrdinal;
  return {
    materiaName: displayName,
    socketOrdinal,
    label: `${displayName}${socketOrdinal === undefined ? "" : ` (${socketOrdinal})`}`,
  };
}

export function formatMateriaCastContent(materiaName: string | undefined, socketId?: string, itemLabel?: string): string {
  const display = formatMateriaNotificationDisplay(materiaName, socketId).label;
  const item = itemLabel?.trim();
  return item ? `Casting **${display}**\n\n${item}` : `Casting **${display}**`;
}
