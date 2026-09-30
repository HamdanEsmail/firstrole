export type PageRoute = 'landing' | 'workspace' | 'privacy';
export type WorkspaceEntryView = 'find' | 'saved' | 'applications';

export function initialPage(location: Pick<Location, 'pathname' | 'search' | 'hash'>): {
  page: PageRoute;
  replacePath?: string;
} {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/privacy') return { page: 'privacy' };
  if (path === '/app') return { page: 'workspace' };
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ''));
  const callback =
    query.has('code') ||
    query.has('error') ||
    fragment.has('access_token') ||
    fragment.has('refresh_token') ||
    fragment.has('error');
  if (path === '/' && callback) {
    // Keep the existing authorized root OAuth redirect. Move the complete URL
    // into the workspace before Supabase reads/exchanges its callback values.
    return { page: 'workspace', replacePath: `/app${location.search}${location.hash}` };
  }
  return { page: 'landing' };
}

export function workspaceEntry(search: string): { view: WorkspaceEntryView; signIn: boolean } {
  const query = new URLSearchParams(search);
  const view = query.get('view');
  return {
    view: view === 'saved' || view === 'applications' ? view : 'find',
    signIn: query.get('signin') === '1',
  };
}
