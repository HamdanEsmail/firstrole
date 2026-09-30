import { useEffect, useRef, useState } from 'react';
import {
  DEFAULT_PREFERENCES,
  type Job,
  type PublicConfig,
  type SearchPreferences,
  type SearchRun,
} from '../shared/types';
import { ApiError, getConfig, startSearch, getSearch, cancelSearch, refreshJob } from './lib/api';
import { useWorkspace } from './hooks/useWorkspace';
import { clearRecoveredPollingError, type PollingError } from './lib/polling-error';
import { workspaceEntry } from './lib/navigation';
import {
  AppHeader,
  AppFooter,
  ComparisonBar,
  WorkspaceToast,
  type WorkspaceView as View,
  type WorkspaceOverlay as Overlay,
} from './components/AppChrome';
import { WorkspaceDialogs } from './components/WorkspaceDialogs';
import { WorkspaceContent } from './components/WorkspaceContent';

const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);
const presets = [
  { role: 'Finance analyst', location: 'Dubai, United Arab Emirates', label: 'Finance in Dubai' },
  {
    role: 'Civil engineering',
    location: 'Chicago, United States',
    label: 'Engineering in Chicago',
  },
  { role: 'Software engineer', location: 'Singapore', label: 'Technology in Singapore' },
];
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Something went wrong. Please try again.';

export default function App() {
  const [config, setConfig] = useState<PublicConfig | null>(null);
  const [configError, setConfigError] = useState(false);
  const workspace = useWorkspace(config);
  const [entry] = useState(() => workspaceEntry(window.location.search));
  const [view, setView] = useState<View>(entry.view);
  const signInFromLanding = useRef(entry.signIn);
  const [preferenceState, setPreferenceState] = useState<{
    scope: string;
    value: SearchPreferences;
  } | null>(null);
  const [runState, setRunState] = useState<{ scope: string; value: SearchRun | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [mobileDetail, setMobileDetail] = useState(false);
  const [compared, setCompared] = useState<string[]>([]);
  const [overlay, setOverlay] = useState<Overlay>(null);
  const [startingScope, setStartingScope] = useState<string | null>(null);
  const [refreshingScope, setRefreshingScope] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [, updateClock] = useState(0);
  const [savedFilter, setSavedFilter] = useState('');
  const [applicationFilter, setApplicationFilter] = useState('All');
  const [deleteText, setDeleteText] = useState('');
  const [deleting, setDeleting] = useState(false);
  const owner = workspace.user?.id || 'guest';
  const identity = useRef({ owner, generation: 0 });
  if (identity.current.owner !== owner)
    identity.current = { owner, generation: identity.current.generation + 1 };
  const scope = `${owner}:${identity.current.generation}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const workspaceReady = config !== null && workspace.ready;
  const readyRef = useRef(workspaceReady);
  readyRef.current = workspaceReady;
  const initializedOwner = useRef<string | null>(null);
  const searchSequence = useRef(0);
  const refreshSequence = useRef(0);
  const startLock = useRef(false);
  const refreshLock = useRef(false);
  const lastPollError = useRef<PollingError | null>(null);
  const preferences =
    preferenceState?.scope === scope && workspaceReady
      ? preferenceState.value
      : DEFAULT_PREFERENCES;
  const run = runState?.scope === scope && workspaceReady ? runState.value : null;
  const runRef = useRef(run);
  runRef.current = run;
  const savedIdsRef = useRef(new Set<string>());
  savedIdsRef.current = new Set(workspace.saved.map((item) => item.job.id));
  const starting = startingScope === scope && workspaceReady;
  const refreshing = refreshingScope === scope && workspaceReady;
  const active = starting || (!!run && !terminal.has(run.status));
  const isCurrent = (requestScope: string) =>
    currentScope.current === requestScope && readyRef.current;
  function setPreferences(
    update: SearchPreferences | ((previous: SearchPreferences) => SearchPreferences),
  ) {
    const updateScope = scope;
    if (currentScope.current !== updateScope) return;
    setPreferenceState((previous) =>
      currentScope.current !== updateScope
        ? previous
        : {
            scope: updateScope,
            value:
              typeof update === 'function'
                ? update(previous?.scope === updateScope ? previous.value : DEFAULT_PREFERENCES)
                : update,
          },
    );
  }
  function setRun(update: SearchRun | null | ((previous: SearchRun | null) => SearchRun | null)) {
    const updateScope = scope;
    if (!isCurrent(updateScope)) return;
    setRunState((previous) => {
      if (!isCurrent(updateScope)) return previous;
      const current = previous?.scope === updateScope ? previous.value : null;
      return { scope: updateScope, value: typeof update === 'function' ? update(current) : update };
    });
  }

  useEffect(() => {
    let disposed = false;
    getConfig()
      .then((c) => {
        if (!disposed) setConfig(c);
      })
      .catch(() => {
        if (!disposed) setConfigError(true);
      });
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    const up = () => setOnline(true),
      down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  useEffect(() => {
    const timer = setInterval(() => updateClock((minute) => minute + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    searchSequence.current += 1;
    refreshSequence.current += 1;
    startLock.current = false;
    refreshLock.current = false;
    lastPollError.current = null;
    setStartingScope(null);
    setRefreshingScope(null);
    setRunState(null);
    setSelected(null);
    setCompared([]);
    setMobileDetail(false);
    setSavedFilter('');
    setApplicationFilter('All');
    setError(null);
    setToast(null);
    setOverlay(null);
    setDeleteText('');
    setDeleting(false);
  }, [scope]);
  useEffect(() => {
    if (workspaceReady && initializedOwner.current !== scope) {
      setPreferences(workspace.preferences);
      initializedOwner.current = scope;
    }
  }, [scope, workspaceReady, workspace.preferences]);
  useEffect(() => {
    if (!workspaceReady || !signInFromLanding.current) return;
    signInFromLanding.current = false;
    setOverlay(workspace.user ? 'account' : 'signin');
    const url = new URL(window.location.href);
    url.searchParams.delete('signin');
    window.history.replaceState(
      window.history.state,
      '',
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [workspaceReady, workspace.user]);
  useEffect(() => {
    if (!workspaceReady) return;
    let disposed = false;
    const restoreScope = scope;
    const sequence = searchSequence.current;
    try {
      const id = sessionStorage.getItem(`firstrole.search.${owner}`);
      if (id)
        void getSearch(id, workspace.accessToken)
          .then((r) => {
            if (!disposed && isCurrent(restoreScope) && sequence === searchSequence.current) {
              setRun(r);
              setSelected(r.results[0]?.id || null);
            }
          })
          .catch((problem) => {
            if (disposed || !isCurrent(restoreScope) || sequence !== searchSequence.current) return;
            if (problem instanceof ApiError && [401, 403, 404].includes(problem.status)) {
              try {
                sessionStorage.removeItem(`firstrole.search.${owner}`);
              } catch {
                /* storage may be blocked */
              }
            } else
              setError(
                'Your previous search could not be restored. Check your connection and reload to reconnect.',
              );
          });
    } catch {
      /* Reload recovery remains optional when browser storage is blocked. */
    }
    return () => {
      disposed = true;
    };
  }, [scope, workspaceReady]);
  useEffect(() => {
    if (!workspaceReady || !run || terminal.has(run.status) || !online) return;
    const pollScope = scope;
    const runId = run.id;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getSearch(runId, workspace.accessToken);
        if (!disposed && isCurrent(pollScope) && runRef.current?.id === runId) {
          const recoveredError = lastPollError.current;
          if (recoveredError)
            setError((previous) =>
              clearRecoveredPollingError(previous, recoveredError, pollScope, runId),
            );
          lastPollError.current = null;
          setRun((previous) => {
            if (!previous || previous.id !== runId) return previous;
            if (terminal.has(previous.status) && !terminal.has(next.status)) return previous;
            if (Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)) return previous;
            return next;
          });
          setSelected((previous) => previous || next.results[0]?.id || null);
        }
      } catch (e) {
        if (!disposed && isCurrent(pollScope) && runRef.current?.id === runId) {
          const message = errorMessage(e);
          lastPollError.current = { scope: pollScope, runId, message };
          setError(message);
        }
      } finally {
        if (!disposed && isCurrent(pollScope) && runRef.current?.id === runId)
          timer = setTimeout(poll, document.hidden ? 15000 : 4000);
      }
    };
    timer = setTimeout(poll, 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [scope, workspaceReady, run?.id, run?.status, workspace.accessToken, online]);

  async function search(force = false) {
    if (!workspaceReady) {
      setError('Your workspace is still loading. Please wait a moment before searching.');
      return;
    }
    if (active || startLock.current) return;
    const requestedPreferences = force && run ? run.preferences : preferences;
    if (requestedPreferences.role.trim().length < 2) {
      setError('Enter a role or keyword with at least two characters.');
      return;
    }
    const requestScope = scope;
    const sequence = ++searchSequence.current;
    startLock.current = true;
    setError(null);
    setStartingScope(scope);
    setView('find');
    setMobileDetail(false);
    // Refresh always repeats the displayed search. Edits in the form are used
    // only when Find jobs is submitted, and remain available as a separate draft.
    if (!force) void workspace.setPreferences(requestedPreferences);
    try {
      const result = await startSearch(requestedPreferences, workspace.accessToken, force, owner);
      if (!isCurrent(requestScope) || sequence !== searchSequence.current) return;
      setRun(result);
      setSelected(result.results[0]?.id || null);
      setCompared([]);
      try {
        sessionStorage.setItem(`firstrole.search.${owner}`, result.id);
      } catch {
        /* no browser persistence */
      }
    } catch (e) {
      if (isCurrent(requestScope) && sequence === searchSequence.current) setError(errorMessage(e));
    } finally {
      if (isCurrent(requestScope) && sequence === searchSequence.current) {
        startLock.current = false;
        setStartingScope(null);
      }
    }
  }
  async function toggleSave(job: Job) {
    if (!workspaceReady) return;
    const requestScope = scope;
    const exists = workspace.saved.some((s) => s.job.id === job.id);
    const ok = exists ? await workspace.remove(job.id) : await workspace.save(job);
    if (ok && isCurrent(requestScope)) setToast(exists ? 'Removed from saved jobs' : 'Job saved');
  }
  async function stopSearch() {
    if (!workspaceReady || !run) return;
    const requestScope = scope;
    const runId = run.id;
    try {
      const stopped = await cancelSearch(runId, workspace.accessToken);
      if (isCurrent(requestScope) && runRef.current?.id === runId) setRun(stopped);
    } catch (e) {
      if (isCurrent(requestScope) && runRef.current?.id === runId) setError(errorMessage(e));
    }
  }
  function toggleCompare(id: string) {
    setCompared((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length === 3) {
        setToast('Compare up to three jobs at a time');
        return prev;
      }
      return [...prev, id];
    });
  }
  function navigate(next: View) {
    setView(next);
    setSelected(null);
    setMobileDetail(false);
    setCompared([]);
    setError(null);
    const url = new URL(window.location.href);
    if (next === 'find') url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    url.searchParams.delete('signin');
    window.history.replaceState(window.history.state, '', `/app${url.search}${url.hash}`);
  }
  function choosePreset(preset: (typeof presets)[number]) {
    setPreferences({ ...DEFAULT_PREFERENCES, role: preset.role, location: preset.location });
    document.querySelector<HTMLInputElement>('input[placeholder="e.g. Data analyst"]')?.focus();
  }
  const savedIds = new Set(workspace.saved.map((s) => s.job.id));
  const allJobs = new Map<string, Job>();
  for (const job of [...workspace.saved.map((s) => s.job), ...(run?.results || [])]) {
    const previous = allJobs.get(job.id);
    if (!previous || Date.parse(job.checkedAt) >= Date.parse(previous.checkedAt))
      allJobs.set(job.id, job);
  }
  const jobs =
    view === 'find'
      ? run?.results || []
      : workspace.saved
          .filter((s) =>
            `${s.job.title} ${s.job.company}`.toLowerCase().includes(savedFilter.toLowerCase()),
          )
          .map((s) => s.job);
  const selectedJob = selected ? allJobs.get(selected) : jobs[0];
  const sourceCount = new Set(jobs.map((job) => new URL(job.sourceUrl).hostname)).size;
  const compareJobs = compared.map((id) => allJobs.get(id)).filter((j): j is Job => !!j);
  const tracked = workspace.saved.filter(
    (s) => applicationFilter === 'All' || s.status === applicationFilter,
  );
  async function recheck(job: Job) {
    if (!workspaceReady || refreshing || refreshLock.current) return;
    const requestScope = scope;
    const sequence = ++refreshSequence.current;
    const sourceSearch = run?.results.some((item) => item.id === job.id) ? run.id : undefined;
    refreshLock.current = true;
    setRefreshingScope(scope);
    setError(null);
    try {
      const updated = await refreshJob(job.id, workspace.accessToken, sourceSearch);
      if (!isCurrent(requestScope) || sequence !== refreshSequence.current) return;
      setRun((prev) =>
        prev
          ? { ...prev, results: prev.results.map((j) => (j.id === job.id ? updated : j)) }
          : prev,
      );
      if (savedIdsRef.current.has(job.id)) {
        const saved = await workspace.save(updated);
        if (!saved || !isCurrent(requestScope) || sequence !== refreshSequence.current) return;
      }
      setToast(
        updated.availability === 'closed'
          ? 'This opportunity is now closed'
          : updated.availability === 'unverified'
            ? 'Availability could not be verified'
            : 'Listing checked',
      );
    } catch (e) {
      if (isCurrent(requestScope) && sequence === refreshSequence.current)
        setError(errorMessage(e));
    } finally {
      if (isCurrent(requestScope) && sequence === refreshSequence.current) {
        refreshLock.current = false;
        setRefreshingScope(null);
      }
    }
  }

  return (
    <div className="app-shell workspace-app">
      <a className="skip-link" href="#main">
        Skip to main content
      </a>
      <AppHeader
        view={view}
        savedCount={workspace.saved.length}
        user={workspace.user}
        navigate={navigate}
        setOverlay={setOverlay}
      />
      <WorkspaceContent
        view={view}
        workspace={workspace}
        workspaceReady={workspaceReady}
        config={config}
        configError={configError}
        online={online}
        error={error}
        mobileDetail={mobileDetail}
        selectedJob={selectedJob}
        preferences={preferences}
        active={active}
        starting={starting}
        refreshing={refreshing}
        run={run}
        terminalRun={Boolean(run && terminal.has(run.status))}
        jobs={jobs}
        tracked={tracked}
        savedIds={savedIds}
        compared={compared}
        scope={scope}
        sourceCount={sourceCount}
        savedFilter={savedFilter}
        applicationFilter={applicationFilter}
        presets={presets}
        navigate={navigate}
        setView={setView}
        setSelected={setSelected}
        setMobileDetail={setMobileDetail}
        setSavedFilter={setSavedFilter}
        setApplicationFilter={setApplicationFilter}
        setError={setError}
        setToast={setToast}
        setPreferences={setPreferences}
        search={search}
        stopSearch={stopSearch}
        toggleSave={toggleSave}
        toggleCompare={toggleCompare}
        recheck={recheck}
        choosePreset={choosePreset}
      />
      <ComparisonBar
        comparedCount={compared.length}
        onCompare={() => setOverlay('compare')}
        onClearComparison={() => setCompared([])}
      />
      <AppFooter
        syncing={workspace.syncing}
        signedIn={Boolean(workspace.user)}
        navigate={navigate}
        setOverlay={setOverlay}
      />
      <WorkspaceToast toast={toast} onDismissToast={() => setToast(null)} />
      <WorkspaceDialogs
        overlay={overlay}
        googleEnabled={Boolean(config?.googleEnabled)}
        syncing={workspace.syncing}
        user={workspace.user}
        compareJobs={compareJobs}
        deleteText={deleteText}
        deleting={deleting}
        setOverlay={setOverlay}
        setDeleteText={setDeleteText}
        setDeleting={setDeleting}
        setToast={setToast}
        signIn={workspace.signIn}
        signOut={workspace.signOut}
        exportData={workspace.exportData}
        deleteAccount={workspace.deleteAccount}
      />
    </div>
  );
}
