export type DomainResult<T> = { ok: true; value: T } | { ok: false; issues: DomainIssue[] };

export interface DomainIssue {
  path: string;
  message: string;
}

export function ok<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function err(path: string, message: string): DomainResult<never> {
  return { ok: false, issues: [{ path, message }] };
}

export function issuesToMessage(issues: readonly DomainIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}
