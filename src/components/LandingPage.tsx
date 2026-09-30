import { useEffect } from 'react';
import {
  ArrowRight,
  Bookmark,
  BriefcaseBusiness,
  CalendarDays,
  ChartNoAxesColumnIncreasing,
  CircleCheck,
  Clock3,
  Coins,
  ExternalLink,
  FileText,
  Globe2,
  GraduationCap,
  MapPin,
  Search,
  ShieldCheck,
  UserRound,
} from 'lucide-react';

const briefFields = [
  {
    Icon: BriefcaseBusiness,
    title: 'Role & employer',
    text: 'The role title and the company hiring, with a link to the original posting.',
  },
  {
    Icon: MapPin,
    title: 'Location & work pattern',
    text: 'Where the role is based and whether it’s on-site, hybrid or remote.',
  },
  {
    Icon: Coins,
    title: 'Pay',
    detail: ' (when stated)',
    text: 'Any salary or pay range, if provided in the original posting.',
  },
  {
    Icon: GraduationCap,
    title: 'Important requirements',
    text: 'Key qualifications, skills or experience needed for the role.',
  },
  {
    Icon: Globe2,
    title: 'Sponsorship',
    detail: ' (when stated)',
    text: 'Whether sponsorship is mentioned in the original posting.',
  },
  {
    Icon: Clock3,
    title: 'Source & last checked',
    text: 'A link to the original posting and when we last checked the details.',
  },
];

const journey = [
  { Icon: Bookmark, title: 'Saved', text: 'Keep track of opportunities that interest you.' },
  {
    Icon: FileText,
    title: 'Applied',
    text: 'Stay organized with all your applications in one place.',
  },
  {
    Icon: CalendarDays,
    title: 'Interviewing',
    text: 'Keep your notes together, so you’re always prepared.',
  },
  {
    Icon: CircleCheck,
    title: 'Outcome',
    text: 'See what’s next, whether it’s an offer or a new opportunity.',
  },
];

export default function LandingPage() {
  useEffect(() => {
    document.title = 'FirstRole — Make your next move';
  }, []);
  return (
    <div className="landing">
      <a className="skip-link" href="#landing-main">
        Skip to main content
      </a>
      <section className="landing-hero" aria-labelledby="landing-title">
        <svg className="hero-arrows" viewBox="0 0 620 520" aria-hidden="true" focusable="false">
          <defs>
            <linearGradient id="arrow-stroke" x1="0" y1="0" x2="1" y2="1">
              <stop stopColor="#0c68ff" />
              <stop offset=".65" stopColor="#42a3ff" />
              <stop offset="1" stopColor="#0e5aeb" />
            </linearGradient>
          </defs>
          <path d="M50 8H187Q195 8 201 14L438 249Q447 258 438 267L201 505Q195 512 187 512H50L291 267Q300 258 291 249Z" />
          <path d="M285 52H370Q378 52 383 58L578 249Q587 258 578 267L383 458Q377 464 370 464H285L485 267Q494 258 485 249Z" />
        </svg>
        <header className="landing-header landing-hero-wrap">
          <a className="landing-wordmark" href="/" aria-label="FirstRole home">
            FirstRole
          </a>
          <nav className="landing-nav" aria-label="Main navigation">
            <a href="#how-it-works">How it works</a>
            <a href="/app">Workspace</a>
          </nav>
          <a className="landing-signin" href="/app?signin=1">
            Sign in
          </a>
        </header>
        <div className="landing-hero-content landing-hero-wrap">
          <h1 id="landing-title">
            Make your
            <br />
            next <span>move.</span>
          </h1>
          <p>Live opportunities. Clear requirements. One place for every next step.</p>
          <div className="landing-hero-actions">
            <a className="landing-button landing-primary" href="/app">
              Find my next role <ArrowRight size={23} />
            </a>
            <a className="landing-button landing-secondary" href="#how-it-works">
              How it works
            </a>
          </div>
        </div>
      </section>

      <main id="landing-main">
        <section
          className="landing-introduction landing-wrap"
          id="how-it-works"
          aria-labelledby="brief-heading"
        >
          <div className="landing-explanation">
            <p className="landing-eyebrow">A smarter way to explore</p>
            <h2 id="brief-heading">
              Know what matters.
              <br />
              <span>Before you apply.</span>
            </h2>
            <p className="landing-lead">
              A clear opportunity brief helps you quickly understand what a role involves—and the
              next steps you can take.
            </p>
            <div className="landing-benefits">
              <div className="landing-benefit">
                <span className="landing-benefit-icon">
                  <FileText size={31} />
                </span>
                <div>
                  <h3>Requirements, made clear</h3>
                  <p>
                    See the key requirements up front, including qualifications, skills and
                    experience.
                  </p>
                </div>
              </div>
              <div className="landing-benefit">
                <span className="landing-benefit-icon">
                  <ShieldCheck size={34} />
                </span>
                <div>
                  <h3>Evidence you can check</h3>
                  <p>Understand where the information comes from and when it was last updated.</p>
                </div>
              </div>
              <div className="landing-benefit">
                <span className="landing-benefit-icon">
                  <ChartNoAxesColumnIncreasing size={34} />
                </span>
                <div>
                  <h3>A place for every step</h3>
                  <p>
                    Save opportunities, track your applications and keep notes — all in one
                    workspace.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <aside className="landing-brief" aria-labelledby="brief-preview-title">
            <h3 id="brief-preview-title">What your opportunity brief includes</h3>
            <div className="landing-brief-sheet">
              <dl>
                {briefFields.map(({ Icon, title, detail, text }) => (
                  <div className="landing-brief-row" key={title}>
                    <dt>
                      <Icon size={28} />
                      <span>
                        <strong>{title}</strong>
                        {detail}
                      </span>
                    </dt>
                    <dd>{text}</dd>
                  </div>
                ))}
              </dl>
              <div className="landing-brief-actions">
                <a
                  className="landing-button landing-primary"
                  href="/app"
                  aria-label="Find a real opportunity to view and apply"
                >
                  View &amp; apply <ExternalLink size={18} />
                </a>
                <a className="landing-button landing-light" href="/app?view=saved">
                  <Bookmark size={20} />
                  Saved roles
                </a>
              </div>
            </div>
          </aside>
        </section>

        <section className="landing-journey landing-wide" aria-labelledby="journey-heading">
          <div className="landing-journey-main">
            <h2 id="journey-heading" className="landing-eyebrow">
              Your application journey
            </h2>
            <ol>
              {journey.map(({ Icon, title, text }) => (
                <li key={title}>
                  <span className="journey-icon">
                    <Icon size={22} />
                  </span>
                  <div>
                    <h3>{title}</h3>
                    <p>{text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="landing-journey-note">
            <h3>You control every status.</h3>
            <p>A workspace built for students, so you can focus on what’s next.</p>
            <a href="/app?view=applications">
              See how it works <ArrowRight size={18} />
            </a>
          </div>
        </section>

        <section className="landing-start" aria-label="Start your search">
          <div className="landing-powered">
            <Search size={43} />
            <div>
              <h3>Powered by a connected search experience.</h3>
              <p>TinyFish Search discovers. Fetch reads. Agent handles interactive pages.</p>
            </div>
          </div>
          <div className="landing-guest">
            <UserRound size={37} />
            <div>
              <h3>Explore as a guest.</h3>
              <p>Sign in to sync across devices.</p>
            </div>
          </div>
          <a className="landing-button landing-light" href="/app">
            Browse opportunities <ArrowRight size={18} />
          </a>
        </section>
      </main>
      <footer className="landing-footer">
        <span>FirstRole · Your next step, with the facts.</span>
        <a href="/privacy">Privacy notice</a>
      </footer>
    </div>
  );
}
