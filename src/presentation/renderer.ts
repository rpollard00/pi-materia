import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  MATERIA_PRESENTATION_ENTRY_TYPE,
  renderMateriaPresentation,
  type MateriaPresentationData,
  type MateriaPresentationDetails,
} from "./materiaPresentation.js";

/** Register the legacy message and transcript-only presentation renderers. */
export function registerMateriaRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<MateriaPresentationDetails>("pi-materia", (message, { expanded }, theme) =>
    renderMateriaPresentation(
      { content: message.content, details: message.details },
      { expanded },
      theme,
    )
  );

  pi.registerEntryRenderer<MateriaPresentationData>(MATERIA_PRESENTATION_ENTRY_TYPE, (entry, { expanded }, theme) => {
    if (!entry.data || typeof entry.data.content !== "string") return undefined;
    return renderMateriaPresentation(entry.data, { expanded }, theme);
  });
}
