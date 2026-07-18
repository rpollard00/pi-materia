import { useState, type FormEvent } from 'react';
import { CentralAdminAuthProvider, useCentralAdminAuth } from './CentralAdminAuth.js';
import { CentralAdminShell } from './CentralAdminShell.js';
import {
  CentralAdminStatePanel,
  centralAdminPrimaryButtonClass,
  centralAdminSecondaryButtonClass,
} from './CentralAdminStatePanel.js';
import { useCentralAdminMode } from './useCentralAdminMode.js';

function CredentialForm({ onSubmit }: { onSubmit: (credential: string) => void }) {
  const [credential, setCredential] = useState('');
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (credential.trim()) onSubmit(credential);
  };
  return (
    <form className="mt-6 flex w-full max-w-xl flex-col gap-3 sm:flex-row" onSubmit={submit}>
      <label className="sr-only" htmlFor="central-admin-credential">Bearer credential</label>
      <input
        id="central-admin-credential"
        type="password"
        autoComplete="current-password"
        value={credential}
        onChange={(event) => setCredential(event.target.value)}
        placeholder="Bearer credential"
        className="min-w-0 flex-1 rounded-full border border-white/15 bg-slate-950/80 px-5 py-3 text-sm text-white outline-none placeholder:text-slate-600 focus:border-cyan-200/70"
      />
      <button type="submit" className={centralAdminPrimaryButtonClass} disabled={!credential.trim()}>
        Connect
      </button>
    </form>
  );
}

function AuthenticationGate() {
  const auth = useCentralAdminAuth();
  if (auth.status === 'authenticated') return <CentralAdminShell />;
  if (auth.status === 'checking') {
    return (
      <CentralAdminStatePanel
        eyebrow="Authentication"
        title="Checking central access"
        description="Verifying the shared bearer credential with the central control plane."
        testId="central-admin-auth-checking"
      />
    );
  }
  if (auth.status === 'signed-out') {
    return (
      <CentralAdminStatePanel
        eyebrow="Central authentication"
        title="Connect to the control plane"
        description={(
          <>
            Enter a reader or administrator bearer credential. It is used only for central catalog, policy, telemetry, and server-information requests.
            <CredentialForm onSubmit={auth.authenticate} />
          </>
        )}
        testId="central-admin-signed-out"
      />
    );
  }
  if (auth.status === 'unauthorized') {
    return (
      <CentralAdminStatePanel
        eyebrow="Unauthorized"
        title="Credential not accepted"
        description={(
          <>
            <p>{auth.message ?? 'The central server rejected this credential.'}</p>
            <CredentialForm onSubmit={auth.authenticate} />
          </>
        )}
        tone="danger"
        testId="central-admin-unauthorized"
      />
    );
  }
  if (auth.status === 'forbidden') {
    return (
      <CentralAdminStatePanel
        eyebrow="Forbidden"
        title="Central access is not permitted"
        description={(
          <>
            <p>{auth.message ?? 'This principal cannot read central administration metadata.'}</p>
            <p className="mt-2">Use a reader or administrator credential with <code>admin.read</code>.</p>
            <CredentialForm onSubmit={auth.authenticate} />
          </>
        )}
        tone="warning"
        testId="central-admin-forbidden"
      />
    );
  }
  return (
    <CentralAdminStatePanel
      eyebrow="Central server unavailable"
      title="Unable to reach the control plane"
      description={auth.message ?? 'The central server did not respond. Local session data is not used as a fallback in this standalone application.'}
      actions={(
        <>
          <button type="button" className={centralAdminPrimaryButtonClass} onClick={auth.retry}>Retry</button>
          <button type="button" className={centralAdminSecondaryButtonClass} onClick={auth.signOut}>Use another credential</button>
        </>
      )}
      tone="warning"
      testId="central-admin-unreachable"
    />
  );
}

/** Standalone central-admin entry root; local WebUI hooks are never mounted. */
export function CentralAdminApp() {
  const mode = useCentralAdminMode();
  if (mode.status === 'loading') {
    return (
      <CentralAdminStatePanel
        eyebrow="Central Admin"
        title="Discovering the control plane"
        description="Confirming that this server is running in standalone central-admin mode."
        testId="central-admin-mode-loading"
      />
    );
  }
  if (mode.status !== 'ready') {
    return (
      <CentralAdminStatePanel
        eyebrow={mode.status === 'incompatible' ? 'Wrong backend mode' : 'Central server unavailable'}
        title={mode.status === 'incompatible' ? 'Standalone control plane required' : 'Unable to discover the control plane'}
        description={mode.message}
        actions={<button type="button" className={centralAdminPrimaryButtonClass} onClick={mode.retry}>Retry</button>}
        tone={mode.status === 'incompatible' ? 'danger' : 'warning'}
        testId={`central-admin-mode-${mode.status}`}
      />
    );
  }
  return (
    <CentralAdminAuthProvider>
      <AuthenticationGate />
    </CentralAdminAuthProvider>
  );
}
