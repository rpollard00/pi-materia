import { Box, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
export function registerMateriaRenderer(pi) {
    pi.registerMessageRenderer("pi-materia", (message, { expanded }, theme) => {
        const details = message.details;
        const prefix = details?.prefix ?? "materia";
        const role = details?.roleName ? ` ${details.roleName}` : "";
        const event = details?.eventType ? ` ${details.eventType.replace(/_/g, " ")}` : "";
        const label = theme.fg("customMessageLabel", `◆ Materia:${role}`);
        const sublabel = theme.fg("dim", ` ${prefix}${event}`);
        const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
        box.addChild(new Text(`${label}${sublabel}`, 0, 0));
        box.addChild(new Spacer(1));
        const body = typeof message.content === "string" ? message.content : "";
        const rendered = expanded || body.length <= 4000
            ? body
            : `${body.slice(0, 4000)}\n\n… ${body.length - 4000} more characters (${theme.fg("dim", "expand to view")})`;
        box.addChild(new Markdown(rendered, 0, 0, getMarkdownTheme(), {
            color: (text) => theme.fg("customMessageText", text),
        }));
        return box;
    });
}
