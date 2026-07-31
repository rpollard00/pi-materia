import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatMateriaNotificationDisplay } from "./notificationFormatting.js";
import { MATERIA_TEXT_OUTPUT_EVENT_TYPE } from "./textOutput.js";

/**
 * Session entry type for Materia cards that should be visible in the
 * transcript but never become model context.
 */
export const MATERIA_PRESENTATION_ENTRY_TYPE = "pi-materia-presentation" as const;

/** Metadata used to identify and label a Materia presentation card. */
export interface MateriaPresentationDetails {
  prefix?: string;
  socketId?: string;
  materiaName?: string;
  eventType?: string;
  [key: string]: unknown;
}

/** Durable payload stored in a pi-materia-presentation custom entry. */
export interface MateriaPresentationData {
  content: string;
  details?: MateriaPresentationDetails;
}

/**
 * Content accepted by the shared renderer. Legacy custom messages may carry
 * structured content arrays, while presentation entries always carry prose.
 */
export interface MateriaPresentationRenderData {
  content?: string | unknown[];
  details?: MateriaPresentationDetails;
}

/**
 * Append a transcript-only Materia card.
 *
 * Custom entries are intentionally used instead of sendMessage: Pi persists
 * them for the session view, but excludes them from model and compaction
 * context by design.
 */
export function appendMateriaPresentation(
  pi: Pick<ExtensionAPI, "appendEntry">,
  data: MateriaPresentationData,
): void {
  pi.appendEntry<MateriaPresentationData>(MATERIA_PRESENTATION_ENTRY_TYPE, data);
}

export interface MateriaPresentationTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

const MESSAGE_BODY_LIMIT = 4000;

/**
 * Render both legacy pi-materia custom messages and new presentation entries.
 * Keeping this path shared ensures cards retain the same metadata labels,
 * expanded-body behavior, and clean text-output styling during migration.
 */
export function renderMateriaPresentation(
  data: MateriaPresentationRenderData,
  options: { expanded: boolean },
  theme: MateriaPresentationTheme,
): Box {
  const details = data.details;
  const materia = formatMateriaNotificationDisplay(details?.materiaName, details?.socketId).label;

  if (details?.eventType === MATERIA_TEXT_OUTPUT_EVENT_TYPE) {
    return renderMateriaTextOutput(materia, data, options, theme);
  }

  return renderMateriaCastNotification(details, materia, data, options, theme);
}

function renderMateriaCastNotification(
  details: MateriaPresentationDetails | undefined,
  materia: string,
  data: MateriaPresentationRenderData,
  options: { expanded: boolean },
  theme: MateriaPresentationTheme,
): Box {
  const prefix = details?.prefix ?? "materia";
  const event = details?.eventType ? ` ${details.eventType.replace(/_/g, " ")}` : "";
  const compactPrefix = prefix === details?.socketId ? "materia" : prefix;
  const label = theme.fg("customMessageLabel", `◆ Materia: ${materia}`);
  const sublabel = theme.fg("dim", ` ${compactPrefix}${event}`);

  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(`${label}${sublabel}`, 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(renderMateriaBody(data, options, theme));
  return box;
}

function renderMateriaTextOutput(
  materia: string,
  data: MateriaPresentationRenderData,
  options: { expanded: boolean },
  theme: MateriaPresentationTheme,
): Box {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(theme.fg("dim", `◆ ${materia}`), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(renderMateriaBody(data, options, theme));
  return box;
}

function renderMateriaBody(
  data: MateriaPresentationRenderData,
  { expanded }: { expanded: boolean },
  theme: MateriaPresentationTheme,
): Markdown {
  const body = typeof data.content === "string" ? data.content : "";
  const rendered = expanded || body.length <= MESSAGE_BODY_LIMIT
    ? body
    : `${body.slice(0, MESSAGE_BODY_LIMIT)}\n\n… ${body.length - MESSAGE_BODY_LIMIT} more characters (${theme.fg("dim", "expand to view")})`;
  return new Markdown(rendered, 0, 0, getMarkdownTheme(), {
    color: (text: string) => theme.fg("customMessageText", text),
  });
}
