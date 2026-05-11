export type HandoffRouteCondition = "always" | "satisfied" | "not_satisfied";
export interface RoutableEdge {
  when: HandoffRouteCondition;
  to: string;
}

const SATISFIED_CONTROL_FIELD = "satisfied";

export function evaluateHandoffRouteCondition(condition: string, satisfied: boolean | undefined): boolean {
  if (condition === "always") return true;
  if (condition === "satisfied") return satisfied === true;
  if (condition === "not_satisfied") return satisfied === false;
  throw new Error(`Unsupported Materia edge condition: ${condition}`);
}

export function selectMatchingEdge<TEdge extends RoutableEdge>(edges: TEdge[], satisfied: boolean | undefined): TEdge | undefined {
  return edges.find((edge) => evaluateHandoffRouteCondition(edge.when, satisfied));
}

export function canonicalSatisfiedField(): typeof SATISFIED_CONTROL_FIELD {
  return SATISFIED_CONTROL_FIELD;
}
