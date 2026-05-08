import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Box, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { formatMateriaNotificationDisplay } from "./notificationFormatting.js";

interface MateriaMessageDetails {
  prefix?: string;
  nodeId?: string;
  materiaName?: string;
  eventType?: string;
}

export function registerMateriaRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<MateriaMessageDetails>("pi-materia", (message, { expanded }, theme) => {
    const details = message.details as MateriaMessageDetails | undefined;
    const prefix = details?.prefix ?? "materia";
    const materia = formatMateriaNotificationDisplay(details?.materiaName, details?.nodeId).label;
    const event = details?.eventType ? ` ${details.eventType.replace(/_/g, " ")}` : "";
    const compactPrefix = prefix === details?.nodeId ? "materia" : prefix;
    const label = theme.fg("customMessageLabel", `◆ Materia: ${materia}`);
    const sublabel = theme.fg("dim", ` ${compactPrefix}${event}`);

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(`${label}${sublabel}`, 0, 0));
    box.addChild(new Spacer(1));

    const body = typeof message.content === "string" ? message.content : "";
    const rendered = expanded || body.length <= 4000
      ? body
      : `${body.slice(0, 4000)}\n\n… ${body.length - 4000} more characters (${theme.fg("dim", "expand to view")})`;

    box.addChild(new Markdown(rendered, 0, 0, getMarkdownTheme(), {
      color: (text: string) => theme.fg("customMessageText", text),
    }));
    return box;
  });
}
