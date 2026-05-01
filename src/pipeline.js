import { resolveArtifactRoot } from "./config.js";
export function resolvePipeline(config) {
    const nodes = Object.fromEntries(Object.keys(config.pipeline.nodes).map((id) => [id, resolveNode(config, id, `pipeline.nodes.${id}`)]));
    const entry = nodes[config.pipeline.entry];
    if (!entry)
        throw new Error(`Unknown pipeline entry slot "${config.pipeline.entry}"`);
    validateTargets(config);
    return { entry, nodes };
}
function resolveNode(config, id, source) {
    const node = config.pipeline.nodes[id];
    if (!node)
        throw new Error(`Unknown pipeline slot "${id}" referenced by ${source}`);
    if (node.type !== "agent")
        throw new Error(`Pipeline slot "${id}" has unsupported type "${node.type}"`);
    const role = config.roles[node.role];
    if (!role)
        throw new Error(`Pipeline slot "${id}" references unknown materia role "${node.role}"`);
    return { id, node, role };
}
function validateTargets(config) {
    for (const [id, node] of Object.entries(config.pipeline.nodes)) {
        validateTarget(config, node.next, `${id}.next`);
        validateTarget(config, node.foreach?.done, `${id}.foreach.done`);
        validateTarget(config, node.advance?.done, `${id}.advance.done`);
        for (const edge of node.edges ?? [])
            validateTarget(config, edge.to, `${id}.edges[].to`);
    }
}
function validateTarget(config, target, source) {
    if (!target || target === "end")
        return;
    if (!config.pipeline.nodes[target])
        throw new Error(`Unknown pipeline slot "${target}" referenced by ${source}`);
}
export function renderGrid(config, pipeline, source, cwd) {
    const lines = [
        "pi-materia Materia Grid",
        `source: ${source}`,
        `artifactDir: ${resolveArtifactRoot(cwd, config.artifactDir)}`,
        `limits: ${formatLimits(config)}`,
        `budget: ${formatBudget(config.budget)}`,
        "",
        "Graph:",
        ...renderGraph(config),
        "",
        "Resolved entry:",
        pipeline.entry.id,
        "",
        "Slots:",
    ];
    for (const [id, node] of Object.entries(config.pipeline.nodes)) {
        const role = config.roles[node.role];
        lines.push(`- ${id}: role=${node.role}, parse=${node.parse ?? "text"}, tools=${role?.tools ?? "unknown"}`);
    }
    return lines;
}
function renderGraph(config) {
    const lines = [];
    for (const [id, node] of Object.entries(config.pipeline.nodes)) {
        if (node.next)
            lines.push(`${id} -> ${node.next}`);
        for (const edge of node.edges ?? [])
            lines.push(`${id} --${edgeLabel(edge)}--> ${edge.to}`);
        if (!node.next && !node.edges?.length)
            lines.push(`${id}`);
    }
    return lines.length > 0 ? lines : ["<empty>"];
}
function edgeLabel(edge) {
    return edge.when ?? "always";
}
function formatLimits(config) {
    return [
        `node visits ${config.limits?.maxNodeVisits ?? 25}`,
        `edge traversals ${config.limits?.maxEdgeTraversals ?? 25}`,
    ].join(", ");
}
function formatBudget(budget) {
    if (!budget)
        return "none";
    return [
        budget.maxTokens === undefined ? undefined : `${budget.maxTokens} tokens`,
        budget.maxCostUsd === undefined ? undefined : `$${budget.maxCostUsd}`,
        budget.warnAtPercent === undefined ? undefined : `warn ${budget.warnAtPercent}%`,
        budget.stopAtLimit === false ? "ask at limit" : "stop at limit",
    ].filter(Boolean).join(", ");
}
