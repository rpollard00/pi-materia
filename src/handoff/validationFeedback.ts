export interface ConciseValidationIssue {
  path: string;
  message: string;
  expected?: string;
  reason?: string;
}

const MAX_VALIDATION_ISSUES = 8;
const MAX_ISSUE_MESSAGE_CHARS = 240;

/** Render bounded, field-level feedback without echoing submitted field values. */
export function formatConciseValidationIssues(
  issues: readonly ConciseValidationIssue[] | undefined,
  options: { maxIssues?: number } = {},
): string[] {
  if (!issues?.length) return [];
  const maxIssues = Math.max(1, options.maxIssues ?? MAX_VALIDATION_ISSUES);
  const visible = issues.slice(0, maxIssues).map((issue) => `- ${issue.path}: ${conciseValidationIssueMessage(issue)}`);
  if (issues.length > visible.length) visible.push(`- … ${issues.length - visible.length} additional issue(s) omitted.`);
  return visible;
}

/** Reduce a validator issue to one bounded instruction; paths are rendered separately. */
export function conciseValidationIssueMessage(issue: ConciseValidationIssue): string {
  let message = issue.message.trim();
  const pathPrefix = `${issue.path}:`;
  if (message.startsWith(pathPrefix)) message = message.slice(pathPrefix.length).trim();
  message = message.replace(/; expected canonical work item shape .*$/i, ".");
  message = message.replace(/\s+/g, " ");
  const guidance = issue.reason?.replace(/\s+/g, " ").trim();
  if (guidance && /^(?:add|call|drop|move|put|remove|rename|replace|submit|use)\b/i.test(guidance)) {
    message = `${message} ${guidance}`;
  }
  if (message.length > MAX_ISSUE_MESSAGE_CHARS) {
    message = `${message.slice(0, MAX_ISSUE_MESSAGE_CHARS - 1).trimEnd()}…`;
  }
  return message || (issue.expected ? `Expected ${issue.expected}.` : "Invalid value.");
}
