import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { formatMateriaNotificationDisplay } from "./notificationFormatting.js";
import { MATERIA_TEXT_OUTPUT_EVENT_TYPE } from "./textOutput.js";

interface MateriaMessageDetails {
  prefix?: string;
  socketId?: string;
  materiaName?: string;
  eventType?: string;
}

interface MateriaTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
}

interface MateriaRenderMessage {
  content?: string | unknown[];
}

const MESSAGE_BODY_LIMIT = 4000;

export function registerMateriaRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<MateriaMessageDetails>("pi-materia", (message, { expanded }, theme) => {
    const details = message.details as MateriaMessageDetails | undefined;
    const materia = formatMateriaNotificationDisplay(details?.materiaName, details?.socketId).label;

    // Renderable text payloads are prose-first: a dim materia attribution and
    // the narration body only. Transport metadata (workItems/satisfied/context)
    // is never shown for these messages.
    if (details?.eventType === MATERIA_TEXT_OUTPUT_EVENT_TYPE) {
      return renderMateriaTextOutput(materia, message, { expanded }, theme);
    }

    return renderMateriaCastNotification(details, materia, message, { expanded }, theme);
  });
}

function renderMateriaCastNotification(
  details: MateriaMessageDetails | undefined,
  materia: string,
  message: MateriaRenderMessage,
  options: { expanded?: boolean },
  theme: MateriaTheme,
): Box {
  const prefix = details?.prefix ?? "materia";
  const event = details?.eventType ? ` ${details.eventType.replace(/_/g, " ")}` : "";
  const compactPrefix = prefix === details?.socketId ? "materia" : prefix;
  const label = theme.fg("customMessageLabel", `◆ Materia: ${materia}`);
  const sublabel = theme.fg("dim", ` ${compactPrefix}${event}`);

  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(`${label}${sublabel}`, 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(renderMateriaBody(message, options, theme));
  return box;
}

function renderMateriaTextOutput(
  materia: string,
  message: MateriaRenderMessage,
  options: { expanded?: boolean },
  theme: MateriaTheme,
): Box {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(theme.fg("dim", `◆ ${materia}`), 0, 0));
  box.addChild(new Spacer(1));
  box.addChild(renderMateriaBody(message, options, theme));
  return box;
}

function renderMateriaBody(
  message: MateriaRenderMessage,
  { expanded }: { expanded?: boolean },
  theme: MateriaTheme,
): Markdown {
  const body = typeof message.content === "string" ? message.content : "";
  const rendered = expanded || body.length <= MESSAGE_BODY_LIMIT
    ? body
    : `${body.slice(0, MESSAGE_BODY_LIMIT)}\n\n… ${body.length - MESSAGE_BODY_LIMIT} more characters (${theme.fg("dim", "expand to view")})`;
  return new Markdown(rendered, 0, 0, getMarkdownTheme(), {
    color: (text: string) => theme.fg("customMessageText", text),
  });
}
