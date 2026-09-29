import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';

interface PrivacyNoticeContentProps {
  headingLevel?: 'h2' | 'h3';
}

export function PrivacyNoticeContent({ headingLevel = 'h2' }: PrivacyNoticeContentProps) {
  const Heading = headingLevel;
  return (
    <div className="privacy-copy">
      <Heading>Your guest workspace</Heading>
      <p>
        Saved jobs, application notes, status, dates, and preferences are stored in this browser
        when you use FirstRole as a guest. Clearing browser storage removes those local copies.
        Guest searches also use a signed session cookie so the service can recognize your search
        requests and keep their progress separate from other visitors.
      </p>
      <Heading>Your Google account and saved data</Heading>
      <p>
        If you choose Google sign-in, FirstRole receives your basic profile and email address to
        identify your account. Supabase provides authentication and stores your account preferences,
        saved job snapshots, application notes, status, and dates. Database ownership rules restrict
        access to your account's workspace. Your browser retains the sign-in session so you can
        return without signing in each time.
      </p>
      <Heading>When you search</Heading>
      <p>
        Your role, location, keywords, and other search filters are sent to TinyFish to discover,
        read, and interact with public careers pages. TinyFish returns public listing content and
        source links. Personal application notes and your Google sign-in identity are not sent to
        TinyFish as part of a job search.
      </p>
      <p>
        Cloudflare hosts FirstRole and handles application requests. Search progress and results are
        stored so you can resume a search. Public job results may be reused for up to six hours with
        their original check times; your private notes are not included in those shared results.
      </p>
      <Heading>Search and usage records</Heading>
      <p>
        FirstRole retains search state and limited usage and provider-operation records to support
        resuming searches, enforce the shared pilot allowance, prevent abuse, and reconcile provider
        costs. Usage counters use pseudonymous identifiers for the actor and network. Stored records
        can remain after their search-access or cache window expires; the application does not
        currently run an automatic periodic deletion process.
      </p>
      <Heading>Your choices</Heading>
      <p>
        You can continue as a guest, choose whether to import guest saves into an account, export
        your saved workspace, or delete your FirstRole account from the account menu. Account
        deletion removes the account's preferences, saved jobs, application notes, and private
        search records. Limited pseudonymous usage and provider accounting records are retained to
        enforce allowances and reconcile pending costs.
      </p>
      <p>
        Deleting FirstRole does not delete your Google account. Guest copies that were never
        imported remain in this browser until you remove them or clear its storage. Exported files
        are copies under your control.
      </p>
      <Heading>When you apply</Heading>
      <p>
        Application links open the employer's or job portal's website, which handles any information
        you submit there. FirstRole does not submit applications, upload a résumé, contact
        recruiters, or read your email messages or Google Drive files.
      </p>
    </div>
  );
}

export default function PrivacyPage() {
  useEffect(() => {
    document.title = 'FirstRole Privacy notice';
  }, []);

  return (
    <div className="app-shell privacy-page">
      <a className="skip-link" href="#main">
        Skip to privacy notice
      </a>
      <header className="site-header">
        <div className="header-inner privacy-header">
          <a className="wordmark" href="/" aria-label="FirstRole home">
            First<span>Role</span>
          </a>
          <a className="text-button" href="/">
            <ArrowLeft size={17} />
            Back to FirstRole
          </a>
        </div>
      </header>
      <main id="main" className="privacy-main">
        <article className="privacy-document">
          <h1>FirstRole Privacy notice</h1>
          <p className="privacy-intro">
            How FirstRole uses information to find opportunities and keep your workspace.
          </p>
          <PrivacyNoticeContent />
        </article>
      </main>
    </div>
  );
}
