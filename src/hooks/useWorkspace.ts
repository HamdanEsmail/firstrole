import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createClient, type Session, type SupabaseClient } from '@supabase/supabase-js';
import {
  DEFAULT_PREFERENCES,
  type Job,
  type PublicConfig,
  type SavedJob,
  type SearchPreferences,
} from '../../shared/types';
import { deleteRemoteAccount } from '../lib/api';
import {
  GUEST_STORAGE_KEY,
  getBrowserStorage,
  parseSavedRow,
  preferencesSchema,
  readGuestWorkspace,
  removeConfirmedImports,
  savedJobSchema,
  savedToRow,
  writeGuestWorkspace,
  type GuestWorkspace,
} from '../lib/storage';

interface WorkspaceData {
  owner: string | null;
  saved: SavedJob[];
  preferences: SearchPreferences;
  loaded: boolean;
}
type SavedPatch = Partial<Pick<SavedJob, 'status' | 'notes' | 'appliedAt'>>;
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : 'This change could not be saved. Please try again.';

export function useWorkspace(config: PublicConfig | null) {
  const [initialGuest] = useState(() => readGuestWorkspace(getBrowserStorage()));
  const guestRef = useRef(initialGuest.workspace);
  const [error, setError] = useState<string | null>(initialGuest.error);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [data, setData] = useState<WorkspaceData>({
    owner: null,
    saved: initialGuest.workspace.saved,
    preferences: initialGuest.workspace.preferences,
    loaded: true,
  });
  const dataRef = useRef(data);
  const epochRef = useRef(0);
  const [pending, setPending] = useState(0);
  const queueRef = useRef<Promise<unknown>>(Promise.resolve());
  const [guestCount, setGuestCount] = useState(initialGuest.workspace.saved.length);
  const [importDismissed, setImportDismissed] = useState(false);
  const supabaseUrl = config?.supabaseUrl ?? '';
  const supabaseKey = config?.supabasePublishableKey ?? '';
  const client = useMemo(() => {
    if (!supabaseUrl || !supabaseKey) return null;
    try {
      return createClient(supabaseUrl, supabaseKey, {
        auth: {
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      });
    } catch {
      return null;
    }
  }, [supabaseUrl, supabaseKey]);
  const userId = session?.user.id ?? null;
  const renderedEpoch = epochRef.current;

  const putData = useCallback((next: WorkspaceData) => {
    dataRef.current = next;
    setData(next);
  }, []);
  const readGuest = useCallback(() => {
    const result = readGuestWorkspace(getBrowserStorage());
    guestRef.current = result.workspace;
    setGuestCount(result.workspace.saved.length);
    return result;
  }, []);

  useEffect(() => {
    let active = true;
    let receivedEvent = false;
    setAuthReady(!client);
    const applySession = (next: Session | null) => {
      if (!active) return;
      const previousId = sessionRef.current?.user.id ?? null;
      const nextId = next?.user.id ?? null;
      if (previousId !== nextId) {
        epochRef.current += 1;
        setImportDismissed(false);
        setError(null);
        // Clear private rows synchronously at the authentication boundary.
        const guest = readGuest();
        putData(
          nextId
            ? { owner: nextId, saved: [], preferences: DEFAULT_PREFERENCES, loaded: false }
            : { owner: null, ...guest.workspace, loaded: true },
        );
      }
      sessionRef.current = next;
      setSession(next);
      setAuthReady(true);
    };
    if (!client) {
      applySession(null);
      return () => {
        active = false;
      };
    }
    const { data: subscription } = client.auth.onAuthStateChange((_event, next) => {
      receivedEvent = true;
      // Supabase auth callbacks remain synchronous to avoid refresh-lock deadlocks.
      applySession(next);
    });
    void client.auth
      .getSession()
      .then(({ data: result, error: authError }) => {
        if (!active || receivedEvent) return;
        if (authError)
          setError(
            'Your account session could not be restored. Sign in again to synchronize your jobs.',
          );
        applySession(authError ? null : result.session);
      })
      .catch(() => {
        if (!active || receivedEvent) return;
        setError(
          'Your account session could not be restored. Check your connection and sign in again.',
        );
        applySession(null);
      });
    const parameters = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    if (parameters.has('error') || fragment.has('error'))
      setError(
        'Google sign-in was not completed. You can continue as a guest or try signing in again.',
      );
    return () => {
      active = false;
      subscription.subscription.unsubscribe();
    };
  }, [client, putData, readGuest]);

  const loadAccount = useCallback(
    async (accountClient: SupabaseClient, owner: string): Promise<WorkspaceData> => {
      const [jobsResult, profileResult] = await Promise.all([
        accountClient
          .from('saved_jobs')
          .select('job, status, notes, applied_at, saved_at, updated_at')
          .eq('user_id', owner)
          .order('saved_at', { ascending: false }),
        accountClient.from('profiles').select('preferences').eq('user_id', owner).maybeSingle(),
      ]);
      if (jobsResult.error || profileResult.error)
        throw new Error(
          'Your account data could not be loaded. Check your connection and reload before making changes.',
        );
      try {
        return {
          owner,
          saved: (jobsResult.data ?? []).map((row) => parseSavedRow(row)),
          preferences: profileResult.data
            ? preferencesSchema.parse(profileResult.data.preferences)
            : { ...DEFAULT_PREFERENCES },
          loaded: true,
        };
      } catch {
        throw new Error(
          'Some saved account data could not be read. It has been preserved on your account.',
        );
      }
    },
    [],
  );

  useEffect(() => {
    if (!client || !userId) return;
    let active = true;
    const epoch = epochRef.current;
    void loadAccount(client, userId)
      .then((next) => {
        if (active && epoch === epochRef.current) putData(next);
      })
      .catch((problem) => {
        if (active && epoch === epochRef.current) setError(messageOf(problem));
      });
    return () => {
      active = false;
    };
  }, [client, userId, loadAccount, putData]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== GUEST_STORAGE_KEY && event.key !== null) return;
      const result = readGuest();
      if (result.error) setError(result.error);
      if (!sessionRef.current) putData({ owner: null, ...result.workspace, loaded: true });
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [readGuest, putData]);

  /** Serialize local mutations, and discard results from an account that has since signed out. */
  const perform = useCallback(
    (
      operation: (owner: string | null, epoch: number) => Promise<void>,
      allowOwnerChange = false,
    ): Promise<boolean> => {
      // A callback captured before an awaited network request belongs to that
      // render's owner; it must never silently target the next signed-in account.
      const owner = userId;
      const epoch = renderedEpoch;
      if (epoch !== epochRef.current || (sessionRef.current?.user.id ?? null) !== owner)
        return Promise.resolve(false);
      setPending((count) => count + 1);
      const task = queueRef.current
        .catch(() => undefined)
        .then(async () => {
          if (epoch !== epochRef.current || (sessionRef.current?.user.id ?? null) !== owner)
            return false;
          setError(null);
          try {
            await operation(owner, epoch);
            return allowOwnerChange || epoch === epochRef.current;
          } catch (problem) {
            if (epoch === epochRef.current) setError(messageOf(problem));
            return false;
          }
        })
        .finally(() => setPending((count) => Math.max(0, count - 1)));
      queueRef.current = task;
      return task;
    },
    [userId, renderedEpoch],
  );

  useEffect(() => {
    if (!client || !userId) return;
    let refreshPending = false;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'hidden' || refreshPending) return;
      refreshPending = true;
      // Read after queued writes, so switching back from another device never
      // replaces an in-flight local edit with an earlier server snapshot.
      void perform(async (owner, epoch) => {
        if (owner !== userId) return;
        const next = await loadAccount(client, userId);
        if (epoch === epochRef.current) putData(next);
      }).finally(() => {
        refreshPending = false;
      });
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [client, userId, perform, loadAccount, putData]);

  const persistGuest = useCallback(
    (change: (current: GuestWorkspace) => GuestWorkspace) => {
      const current = readGuestWorkspace(getBrowserStorage());
      if (current.error) throw new Error(current.error);
      const next = change(current.workspace);
      writeGuestWorkspace(getBrowserStorage(), next);
      guestRef.current = next;
      setGuestCount(next.saved.length);
      putData({ owner: null, ...next, loaded: true });
    },
    [putData],
  );

  const currentAccount = useCallback(
    (owner: string) => {
      const current = dataRef.current;
      if (!client || !current.loaded || current.owner !== owner)
        throw new Error('Your account is still loading. Wait a moment and try again.');
      return { client, current };
    },
    [client],
  );

  const setPreferences = useCallback(
    (preferences: SearchPreferences) =>
      perform(async (owner, epoch) => {
        const parsed = preferencesSchema.safeParse(preferences);
        if (!parsed.success)
          throw new Error(
            'Please check your search preferences. Some values are too long or invalid.',
          );
        if (!owner) {
          persistGuest((current) => ({ ...current, preferences: parsed.data }));
          return;
        }
        const { client: accountClient, current } = currentAccount(owner);
        const result = await accountClient
          .from('profiles')
          .upsert({ user_id: owner, preferences: parsed.data }, { onConflict: 'user_id' })
          .select('preferences')
          .single();
        if (result.error || !result.data)
          throw new Error('Your preferences could not be synchronized. Please try again.');
        if (epoch === epochRef.current)
          putData({ ...current, preferences: preferencesSchema.parse(result.data.preferences) });
      }),
    [perform, persistGuest, currentAccount, putData],
  );

  const save = useCallback(
    (job: Job) =>
      perform(async (owner, epoch) => {
        const now = new Date().toISOString();
        const createSaved = (previous?: SavedJob): SavedJob =>
          savedJobSchema.parse(
            previous
              ? { ...previous, job, updatedAt: now }
              : { job, status: 'Saved', notes: '', appliedAt: null, savedAt: now, updatedAt: now },
          );
        if (!owner) {
          persistGuest((current) => {
            const next = createSaved(current.saved.find((item) => item.job.id === job.id));
            return {
              ...current,
              saved: [next, ...current.saved.filter((item) => item.job.id !== job.id)],
            };
          });
          return;
        }
        const { client: accountClient, current } = currentAccount(owner);
        const next = createSaved(current.saved.find((item) => item.job.id === job.id));
        // Upsert the job snapshot only for existing records, preserving notes changed on another device.
        const existing = current.saved.some((item) => item.job.id === job.id);
        const result = existing
          ? await accountClient
              .from('saved_jobs')
              .update({ job, updated_at: now })
              .eq('user_id', owner)
              .eq('job_id', job.id)
              .select('job, status, notes, applied_at, saved_at, updated_at')
              .single()
          : await accountClient
              .from('saved_jobs')
              .upsert(savedToRow(next, owner), {
                onConflict: 'user_id,job_id',
                ignoreDuplicates: true,
              })
              .select('job, status, notes, applied_at, saved_at, updated_at');
        if (result.error)
          throw new Error('This job could not be saved to your account. Please try again.');
        const verified = await accountClient
          .from('saved_jobs')
          .select('job, status, notes, applied_at, saved_at, updated_at')
          .eq('user_id', owner)
          .eq('job_id', job.id)
          .single();
        if (verified.error || !verified.data)
          throw new Error('We could not confirm this job was saved. Please refresh your account.');
        const saved = parseSavedRow(verified.data);
        if (epoch === epochRef.current)
          putData({
            ...current,
            saved: [saved, ...current.saved.filter((item) => item.job.id !== job.id)],
          });
      }),
    [perform, persistGuest, currentAccount, putData],
  );

  const remove = useCallback(
    (jobId: string) =>
      perform(async (owner, epoch) => {
        if (!owner) {
          persistGuest((current) => ({
            ...current,
            saved: current.saved.filter((item) => item.job.id !== jobId),
          }));
          return;
        }
        const { client: accountClient, current } = currentAccount(owner);
        const result = await accountClient
          .from('saved_jobs')
          .delete()
          .eq('user_id', owner)
          .eq('job_id', jobId);
        if (result.error) throw new Error('This job could not be removed. Please try again.');
        const verified = await accountClient
          .from('saved_jobs')
          .select('job_id')
          .eq('user_id', owner)
          .eq('job_id', jobId)
          .maybeSingle();
        if (verified.error || verified.data)
          throw new Error('We could not confirm the job was removed. Please try again.');
        if (epoch === epochRef.current)
          putData({ ...current, saved: current.saved.filter((item) => item.job.id !== jobId) });
      }),
    [perform, persistGuest, currentAccount, putData],
  );

  const update = useCallback(
    (jobId: string, patch: SavedPatch) =>
      perform(async (owner, epoch) => {
        const now = new Date().toISOString();
        if (!owner) {
          persistGuest((current) => {
            if (!current.saved.some((item) => item.job.id === jobId))
              throw new Error('Save this job before adding application details.');
            return {
              ...current,
              saved: current.saved.map((item) =>
                item.job.id === jobId
                  ? savedJobSchema.parse({ ...item, ...patch, updatedAt: now })
                  : item,
              ),
            };
          });
          return;
        }
        const { client: accountClient, current } = currentAccount(owner);
        const existing = current.saved.find((item) => item.job.id === jobId);
        if (!existing) throw new Error('Save this job before adding application details.');
        const valid = savedJobSchema.parse({ ...existing, ...patch, updatedAt: now });
        const columns: Record<string, unknown> = { updated_at: now };
        if ('status' in patch) columns.status = valid.status;
        if ('notes' in patch) columns.notes = valid.notes;
        if ('appliedAt' in patch) columns.applied_at = valid.appliedAt;
        const result = await accountClient
          .from('saved_jobs')
          .update(columns)
          .eq('user_id', owner)
          .eq('job_id', jobId)
          .select('job, status, notes, applied_at, saved_at, updated_at')
          .single();
        if (result.error || !result.data)
          throw new Error('Your application details could not be synchronized. Please try again.');
        const saved = parseSavedRow(result.data);
        if (epoch === epochRef.current)
          putData({
            ...current,
            saved: current.saved.map((item) => (item.job.id === jobId ? saved : item)),
          });
      }),
    [perform, persistGuest, currentAccount, putData],
  );

  const importGuest = useCallback(
    () =>
      perform(async (owner, epoch) => {
        if (!owner) throw new Error('Sign in before importing your saved jobs.');
        const { client: accountClient } = currentAccount(owner);
        const guest = readGuestWorkspace(getBrowserStorage());
        if (guest.error) throw new Error(guest.error);
        if (!guest.workspace.saved.length) return;
        const snapshots = guest.workspace.saved;
        const result = await accountClient.from('saved_jobs').upsert(
          snapshots.map((item) => savedToRow(item, owner)),
          { onConflict: 'user_id,job_id', ignoreDuplicates: true },
        );
        if (result.error)
          throw new Error(
            'Your guest jobs could not be imported. Your local copies are still safe.',
          );
        const verified = await loadAccount(accountClient, owner);
        const confirmedIds = new Set(verified.saved.map((item) => item.job.id));
        if (!snapshots.every((item) => confirmedIds.has(item.job.id)))
          throw new Error(
            'Some imported jobs could not be verified. Your local copies have been kept.',
          );
        if (epoch !== epochRef.current) return;
        putData(verified);
        const latest = readGuestWorkspace(getBrowserStorage());
        if (latest.error)
          throw new Error(
            'Your jobs were imported, but the local copies could not be cleared. They have been kept safely.',
          );
        const next = {
          ...latest.workspace,
          saved: removeConfirmedImports(latest.workspace.saved, snapshots, confirmedIds),
        };
        writeGuestWorkspace(getBrowserStorage(), next);
        guestRef.current = next;
        setGuestCount(next.saved.length);
        setImportDismissed(next.saved.length === 0);
      }),
    [perform, currentAccount, loadAccount, putData],
  );

  const signIn = useCallback(async (): Promise<boolean> => {
    setError(null);
    if (!client || !config?.googleEnabled) {
      setError('Google sign-in is not configured yet. Your guest saves still work on this device.');
      return false;
    }
    try {
      const result = await client.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${window.location.origin}/`,
          scopes: 'openid email profile',
          queryParams: { prompt: 'select_account' },
        },
      });
      if (result.error) throw result.error;
      return true;
    } catch {
      setError('Google sign-in could not be started. Check your connection and try again.');
      return false;
    }
  }, [client, config?.googleEnabled]);

  const signOut = useCallback(async (): Promise<boolean> => {
    if (!client) return true;
    setError(null);
    try {
      const result = await client.auth.signOut({ scope: 'local' });
      if (result.error) throw result.error;
      return true;
    } catch {
      setError('Sign-out could not be completed. Please try again.');
      return false;
    }
  }, [client]);

  const exportData = useCallback((): boolean => {
    try {
      const current = dataRef.current;
      if (current.owner !== (sessionRef.current?.user.id ?? null) || !current.loaded)
        throw new Error('Wait until your workspace finishes loading before exporting.');
      const payload: Record<string, unknown> = {
        format: 'firstrole-export-v1',
        exportedAt: new Date().toISOString(),
        preferences: current.preferences,
        saved: current.saved,
      };
      if (!sessionRef.current && readGuestWorkspace(getBrowserStorage()).error)
        payload.recoveryData = getBrowserStorage()?.getItem(GUEST_STORAGE_KEY) ?? null;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `firstrole-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return true;
    } catch (problem) {
      setError(messageOf(problem));
      return false;
    }
  }, []);

  const deleteAccount = useCallback(
    () =>
      perform(async (owner) => {
        const token = sessionRef.current?.access_token;
        if (!owner || !token || !client)
          throw new Error('Sign in before deleting your account data.');
        const response = await deleteRemoteAccount(token);
        if (!response.ok) throw new Error('Account deletion was not confirmed. Please try again.');
        const result = await client.auth.signOut({ scope: 'local' });
        if (result.error)
          throw new Error(
            'Your account was deleted, but this browser could not finish signing out. Reload the page.',
          );
      }, true),
    [perform, client],
  );

  const visibleData =
    data.owner === userId ? data : { saved: [], preferences: DEFAULT_PREFERENCES, loaded: false };
  const user = session?.user
    ? {
        id: session.user.id,
        email: session.user.email,
        name:
          typeof session.user.user_metadata?.full_name === 'string'
            ? session.user.user_metadata.full_name
            : undefined,
      }
    : null;
  return {
    user,
    ready: authReady && visibleData.loaded,
    saved: visibleData.saved,
    preferences: visibleData.preferences,
    setPreferences,
    save,
    remove,
    update,
    signIn,
    signOut,
    importGuest,
    guestImportCount: user && !importDismissed ? guestCount : 0,
    dismissImport: () => setImportDismissed(true),
    exportData,
    deleteAccount,
    error,
    syncing: pending > 0,
    accessToken: session?.access_token ?? null,
    clearError: () => setError(null),
  };
}
