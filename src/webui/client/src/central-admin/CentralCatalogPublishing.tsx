import { useState, type FormEvent } from 'react';
import {
  CentralCatalogConflictError,
  createCentralCatalogItem,
  deleteCentralCatalogItem,
  updateCentralCatalogItem,
  type CentralCatalogItemDraft,
} from './catalogApi.js';
import type { CentralAdminRequester } from './api.js';
import type {
  CentralCatalogItem,
  CentralCatalogItemKind,
  CentralCatalogItemSummary,
  CentralCatalogProvenance,
} from './catalogTypes.js';

const fieldClass = 'rounded-xl border border-white/15 bg-slate-950/90 px-3 py-2.5 text-sm text-slate-100 outline-none focus:border-cyan-200/70 disabled:cursor-not-allowed disabled:opacity-60';
const primaryButtonClass = 'rounded-full border border-cyan-200/40 bg-cyan-900/60 px-4 py-2 text-xs font-black text-cyan-50 transition hover:border-cyan-100/80 hover:bg-cyan-800/70 disabled:cursor-wait disabled:opacity-50';
const secondaryButtonClass = 'rounded-full border border-white/15 bg-slate-900/70 px-4 py-2 text-xs font-black text-slate-200 transition hover:border-white/30 hover:bg-slate-800 disabled:cursor-wait disabled:opacity-50';
const dangerButtonClass = 'rounded-full border border-rose-300/40 bg-rose-950/60 px-4 py-2 text-xs font-black text-rose-100 transition hover:border-rose-200/80 hover:bg-rose-900/70 disabled:cursor-wait disabled:opacity-50';

interface EditorState {
  id: string;
  kind: CentralCatalogItemKind;
  name: string;
  description: string;
  provenanceSource: string;
  provenanceAuthor: string;
  provenanceRepositoryId: string;
  definitionJson: string;
  extraProvenance: CentralCatalogProvenance;
}

function initialEditorState(item: CentralCatalogItem | undefined): EditorState {
  const provenance = item?.provenance ?? {};
  const extraProvenance = Object.fromEntries(
    Object.entries(provenance).filter(([key]) => !['source', 'author', 'repositoryId'].includes(key)),
  );
  return {
    id: item?.id ?? '',
    kind: item?.kind ?? 'materia',
    name: item?.name ?? '',
    description: item?.description ?? '',
    provenanceSource: typeof provenance.source === 'string' ? provenance.source : '',
    provenanceAuthor: typeof provenance.author === 'string' ? provenance.author : '',
    provenanceRepositoryId: typeof provenance.repositoryId === 'string' ? provenance.repositoryId : '',
    definitionJson: JSON.stringify(item?.content.definition ?? {}, null, 2),
    extraProvenance,
  };
}

function nonEmpty(value: string): string | undefined {
  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function parseDraft(state: EditorState): { draft?: CentralCatalogItemDraft; error?: string } {
  const id = state.id.trim();
  if (!id) return { error: 'Central id is required.' };

  let definition: unknown;
  try {
    definition = JSON.parse(state.definitionJson);
  } catch (error) {
    return { error: `Definition JSON is invalid: ${error instanceof Error ? error.message : 'unable to parse JSON'}` };
  }
  if (typeof definition !== 'object' || definition === null || Array.isArray(definition)) {
    return { error: 'Definition JSON must have an object at its top level.' };
  }

  const provenance: CentralCatalogProvenance = {
    ...state.extraProvenance,
    ...(nonEmpty(state.provenanceSource) !== undefined ? { source: nonEmpty(state.provenanceSource) } : {}),
    ...(nonEmpty(state.provenanceAuthor) !== undefined ? { author: nonEmpty(state.provenanceAuthor) } : {}),
    ...(nonEmpty(state.provenanceRepositoryId) !== undefined ? { repositoryId: nonEmpty(state.provenanceRepositoryId) } : {}),
  };
  return {
    draft: {
      id,
      kind: state.kind,
      ...(nonEmpty(state.name) !== undefined ? { name: nonEmpty(state.name) } : {}),
      ...(nonEmpty(state.description) !== undefined ? { description: nonEmpty(state.description) } : {}),
      definition: definition as Record<string, unknown>,
      ...(Object.keys(provenance).length > 0 ? { provenance } : {}),
    },
  };
}

function failureMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'The central catalog operation did not complete.';
}

function DialogFrame({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-950/85 px-4 py-8 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={title}>
      <div className="w-full max-w-4xl rounded-3xl border border-cyan-200/30 bg-slate-900 p-5 shadow-[0_0_60px_rgba(34,211,238,0.18)] md:p-7">
        {children}
      </div>
    </div>
  );
}

export interface CentralCatalogEditorProps {
  mode: 'create' | 'edit';
  item?: CentralCatalogItem;
  request: CentralAdminRequester;
  onCancel: () => void;
  onSucceeded: (summary: CentralCatalogItemSummary) => void;
}

/** Admin catalog create/edit form. Draft state stays mounted after conflicts. */
export function CentralCatalogEditor({ mode, item, request, onCancel, onSucceeded }: CentralCatalogEditorProps) {
  const [state, setState] = useState<EditorState>(() => initialEditorState(item));
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState<string>();
  const [failure, setFailure] = useState<string>();
  const [conflict, setConflict] = useState<CentralCatalogConflictError>();
  const editing = mode === 'edit';

  const update = <K extends keyof EditorState>(field: K, value: EditorState[K]) => {
    setState((current) => ({ ...current, [field]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const parsed = parseDraft(state);
    if (!parsed.draft) {
      setValidationError(parsed.error ?? 'The catalog draft is invalid.');
      return;
    }
    if (editing && !item) {
      setValidationError('The published definition must be loaded before it can be edited.');
      return;
    }

    setSubmitting(true);
    setValidationError(undefined);
    setFailure(undefined);
    setConflict(undefined);
    try {
      const summary = editing
        ? await updateCentralCatalogItem(request, parsed.draft, item!.version)
        : await createCentralCatalogItem(request, parsed.draft);
      onSucceeded(summary);
    } catch (error) {
      if (error instanceof CentralCatalogConflictError) setConflict(error);
      else setFailure(failureMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  const title = editing ? `Edit ${item?.kind ?? 'catalog'} definition` : 'Create catalog definition';
  return (
    <DialogFrame title={title}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs font-black uppercase tracking-[0.25em] text-cyan-200">Catalog publishing</p>
          <h3 className="mt-2 text-2xl font-black text-white">{title}</h3>
          {editing ? <p className="mt-2 text-sm text-slate-400">Editing published version {item?.version} with optimistic concurrency.</p> : null}
        </div>
        <button type="button" className={secondaryButtonClass} onClick={onCancel} disabled={submitting}>Close</button>
      </div>

      <form className="mt-6 grid gap-5" onSubmit={submit}>
        <fieldset className="grid gap-4 rounded-2xl border border-white/10 bg-slate-950/45 p-4 md:grid-cols-2" disabled={submitting}>
          <legend className="px-2 text-xs font-black uppercase tracking-[0.2em] text-slate-400">Identity and metadata</legend>
          <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
            Central id
            <input aria-label="Central id" className={fieldClass} value={state.id} onChange={(event) => update('id', event.target.value)} disabled={editing || submitting} required />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
            Kind
            <select aria-label="Definition kind" className={fieldClass} value={state.kind} onChange={(event) => update('kind', event.target.value as CentralCatalogItemKind)} disabled={editing || submitting}>
              <option value="materia">Materia</option>
              <option value="loadout">Loadout</option>
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
            Display name
            <input aria-label="Display name" className={fieldClass} value={state.name} onChange={(event) => update('name', event.target.value)} placeholder="Optional catalog name" />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400 md:col-span-2">
            Description
            <textarea aria-label="Description" className={`${fieldClass} min-h-20 resize-y`} value={state.description} onChange={(event) => update('description', event.target.value)} placeholder="Optional operator-facing description" />
          </label>
        </fieldset>

        <fieldset className="grid gap-4 rounded-2xl border border-white/10 bg-slate-950/45 p-4 md:grid-cols-3" disabled={submitting}>
          <legend className="px-2 text-xs font-black uppercase tracking-[0.2em] text-slate-400">Provenance</legend>
          <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
            Source
            <input aria-label="Provenance source" className={fieldClass} value={state.provenanceSource} onChange={(event) => update('provenanceSource', event.target.value)} placeholder="central" />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
            Author
            <input aria-label="Provenance author" className={fieldClass} value={state.provenanceAuthor} onChange={(event) => update('provenanceAuthor', event.target.value)} />
          </label>
          <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
            Repository id
            <input aria-label="Provenance repository id" className={fieldClass} value={state.provenanceRepositoryId} onChange={(event) => update('provenanceRepositoryId', event.target.value)} />
          </label>
        </fieldset>

        <label className="flex flex-col gap-1.5 text-xs font-bold uppercase tracking-[0.15em] text-slate-400">
          Definition JSON
          <textarea
            aria-label="Definition JSON"
            className={`${fieldClass} min-h-[20rem] resize-y font-mono text-xs leading-6`}
            value={state.definitionJson}
            onChange={(event) => update('definitionJson', event.target.value)}
            spellCheck={false}
            disabled={submitting}
          />
        </label>

        {validationError ? <div className="rounded-xl border border-amber-300/30 bg-amber-950/30 px-4 py-3 text-sm text-amber-100" role="alert" data-testid="central-catalog-validation-error">{validationError}</div> : null}
        {conflict ? (
          <div className="rounded-xl border border-amber-300/40 bg-amber-950/35 px-4 py-3 text-sm text-amber-100" role="alert" data-testid="central-catalog-conflict">
            <strong>409 publishing conflict.</strong> {conflict.message}
            {conflict.currentVersion ? <> The server reports version <strong>{conflict.currentVersion}</strong>. Your edits are still here; close and refresh before deciding how to reconcile them.</> : <> Your edits are still here so you can review or copy them.</>}
          </div>
        ) : null}
        {failure ? <div className="rounded-xl border border-rose-300/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-100" role="alert" data-testid="central-catalog-publish-error">{failure}</div> : null}

        <div className="flex flex-wrap justify-end gap-3">
          <button type="button" className={secondaryButtonClass} onClick={onCancel} disabled={submitting}>Cancel</button>
          <button type="submit" className={primaryButtonClass} disabled={submitting}>{submitting ? 'Publishing…' : editing ? 'Publish update' : 'Create definition'}</button>
        </div>
      </form>
    </DialogFrame>
  );
}

export interface CentralCatalogDeleteConfirmationProps {
  item: CentralCatalogItem;
  request: CentralAdminRequester;
  onCancel: () => void;
  onSucceeded: (summary: CentralCatalogItemSummary) => void;
}

/** Explicit destructive confirmation that also preserves a 409 for review. */
export function CentralCatalogDeleteConfirmation({ item, request, onCancel, onSucceeded }: CentralCatalogDeleteConfirmationProps) {
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [conflict, setConflict] = useState<CentralCatalogConflictError>();

  const confirm = async () => {
    setSubmitting(true);
    setFailure(undefined);
    setConflict(undefined);
    try {
      onSucceeded(await deleteCentralCatalogItem(request, item));
    } catch (error) {
      if (error instanceof CentralCatalogConflictError) setConflict(error);
      else setFailure(failureMessage(error));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DialogFrame title={`Delete ${item.kind} ${item.id}`}>
      <p className="text-xs font-black uppercase tracking-[0.25em] text-rose-200">Destructive catalog action</p>
      <h3 className="mt-2 text-2xl font-black text-white">Delete published definition?</h3>
      <p className="mt-4 text-sm leading-6 text-slate-300">
        This permanently removes <strong className="text-white">{item.name || item.id}</strong> (<code>{item.kind}:{item.id}</code>) at expected version <strong>{item.version}</strong>.
      </p>
      <p className="mt-2 text-sm font-bold text-rose-200">Connected runtimes may stop receiving this central definition. This action cannot be undone.</p>

      {conflict ? (
        <div className="mt-5 rounded-xl border border-amber-300/40 bg-amber-950/35 px-4 py-3 text-sm text-amber-100" role="alert" data-testid="central-catalog-delete-conflict">
          <strong>409 delete conflict.</strong> {conflict.message} The definition was not deleted. Refresh it before trying again.
        </div>
      ) : null}
      {failure ? <div className="mt-5 rounded-xl border border-rose-300/30 bg-rose-950/30 px-4 py-3 text-sm text-rose-100" role="alert" data-testid="central-catalog-delete-error">{failure}</div> : null}

      <div className="mt-7 flex flex-wrap justify-end gap-3">
        <button type="button" className={secondaryButtonClass} onClick={onCancel} disabled={submitting}>Cancel</button>
        <button type="button" className={dangerButtonClass} onClick={confirm} disabled={submitting}>{submitting ? 'Deleting…' : `Confirm delete ${item.id}`}</button>
      </div>
    </DialogFrame>
  );
}
