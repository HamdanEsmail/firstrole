// Source-only text shaping. These helpers do not infer missing facts or call a model.
export function plainText(value: string): string {
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/&amp;/gi, '&')
    .replace(/&nbsp;/gi, ' ')
    .replace(/[ \t\u00a0]+/g, ' ')
    .trim();
}

function boundedProse(value: string, limit = 950): string {
  const text = plainText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const prefix = text.slice(0, limit);
  const sentences = [...prefix.matchAll(/[.!?](?=\s|$)/g)];
  const boundary = sentences.at(-1)?.index;
  if (boundary !== undefined && boundary >= limit / 2) return prefix.slice(0, boundary + 1);
  const space = prefix.lastIndexOf(' ');
  return `${prefix.slice(0, space > 0 ? space : limit).trimEnd()}…`;
}

function sourceSentences(value: string): string[] {
  const masked = plainText(value).replace(/\b(?:[A-Za-z]\.){2,}/g, (part) =>
    part.replaceAll('.', '\uE000'),
  );
  return masked
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/u)
    .map((part) => part.replaceAll('\uE000', '.').trim())
    .filter(Boolean);
}

function claimText(value: string): string {
  return plainText(value)
    .toLowerCase()
    .replace(/^preferred:\s*|\s*\(preferred\)\s*$/g, '')
    .replace(/completion of/g, 'completed')
    .replace(/proficiency|proficient/g, 'proficient')
    .replace(/\bone\b/g, '1')
    .replace(/\btwo\b/g, '2')
    .replace(/[’']/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function sourceConfirmsClaim(claim: string, source: string): boolean {
  const candidate = claimText(claim);
  if (candidate.split(' ').length < 3) return false;
  return sourceSentences(source).some((sentence) => {
    const actual = claimText(sentence);
    const index = actual.indexOf(candidate);
    if (index < 0) return false;
    const prefix = actual.slice(Math.max(0, index - 45), index);
    return !(
      /\b(?:no|not|never|without)\b/.test(prefix) && !/\b(?:no|not|never|without)\b/.test(candidate)
    );
  });
}

export function confirmedDescription(previous: string, source: string): string {
  return boundedProse(
    sourceSentences(previous)
      .filter(
        (sentence) => !excluded.test(plainText(sentence)) && sourceConfirmsClaim(sentence, source),
      )
      .join(' '),
  );
}

export function mergeConfirmedRequirements(previous: string[], fresh: string[]): string[] {
  const confirmed = previous.flatMap((requirement) => {
    const matching = fresh.find((actual) => sourceConfirmsClaim(requirement, actual));
    if (!matching) return [];
    const clean = requirement.replace(/^Preferred:\s*|\s*\(preferred\)\s*$/gi, '');
    return [/^Preferred:/i.test(matching) ? `Preferred: ${clean}` : clean];
  });
  const filler = new Set([
    'a',
    'an',
    'the',
    'candidates',
    'candidate',
    'applicants',
    'applicant',
    'must',
    'be',
    'have',
    'has',
    'and',
    'as',
    'a',
    'condition',
    'of',
    'employment',
    'selected',
  ]);
  const significant = (value: string) =>
    claimText(value)
      .split(' ')
      .filter((word) => !filler.has(word));
  const output = [...confirmed];
  for (const requirement of fresh) {
    const covered = new Set(output.flatMap(significant));
    if (significant(requirement).every((word) => covered.has(word))) continue;
    output.push(requirement);
  }
  return [...new Set(output)]
    .sort((a, b) => Number(/^Preferred:/i.test(a)) - Number(/^Preferred:/i.test(b)))
    .slice(0, 8);
}

export interface SourceCompensation {
  text: string;
  currency: string | null;
  period: string | null;
  evidence: string;
}
export function extractCompensation(value: string): SourceCompensation | null {
  const source = plainText(value).slice(0, 60_000);
  const matched = source.match(
    /\b(?:Compensation|Salary(?: range)?|Pay range|Base pay)\s*:\s*([^\n]{1,220})/i,
  );
  if (!matched) return null;
  const amount = matched[1]
    .split(
      /\s+(?:Company Description|Legal Entity|Business Line|Primary Location|Work Location Model|Additional Information|Qualifications|Benefits)\b/i,
    )[0]
    .trim();
  if (
    !/^(?:(?:USD|AED|GBP|EUR|CAD|AUD|SAR|QAR)\s*|[$€£]\s*)\d/i.test(amount) ||
    /\b(?:billion|revenue)\b/i.test(amount)
  )
    return null;
  const currency =
    amount.match(/\b(USD|AED|GBP|EUR|CAD|AUD|SAR|QAR)\b/i)?.[1]?.toUpperCase() || null;
  const unit =
    amount
      .match(
        /\b(hourly|annually|yearly|monthly|weekly|daily|per hour|per year|per month|per week|per day)\b|\/\s*(hr|hour|year|month|week|day)\b/i,
      )?.[0]
      ?.toLowerCase() || null;
  const periods: Record<string, string> = {
    'per hour': 'hourly',
    '/hr': 'hourly',
    '/hour': 'hourly',
    annually: 'yearly',
    'per year': 'yearly',
    '/year': 'yearly',
    'per month': 'monthly',
    '/month': 'monthly',
    'per week': 'weekly',
    '/week': 'weekly',
    'per day': 'daily',
    '/day': 'daily',
  };
  return {
    text: boundedProse(amount, 200),
    currency,
    period: unit
      ? periods[unit.replace(/\s/g, '').startsWith('/') ? unit.replace(/\s/g, '') : unit] || unit
      : null,
    evidence: `${matched[0].slice(0, matched[0].indexOf(':') + 1)} ${amount}`,
  };
}

const label = (line: string) =>
  plainText(line)
    .replace(/[’‘]/g, "'")
    .replace(/[:\s]+$/, '')
    .toLowerCase();
const requirementLabel =
  /^(?:(?:minimum|required|preferred|basic|essential|desired)\s+)?(?:qualifications?|requirements?|skills(?: and experience)?)$|^what (?:you bring|you'll bring|you will bring|you need|we're looking for)|^who you are$|^must haves?$/i;
const excluded =
  /cookie|privacy notice|skip to (?:main )?content|page is loaded|tailored advertising|sign (?:in|up)|equal opportunity|employment decisions|recruitment fraud|fraudulent recruitment|all rights reserved|^(?:legal entity|business line|primary location|work location model|compensation|company description)\b|^apply(?: now)?$|^welcome[!.]?$|^share (?:this )?job|^save (?:this )?job/i;

function heading(line: string): string | null {
  const clean = label(line);
  if (!clean || clean.length > 110) return null;
  if (/^\s*#{1,6}\s+/.test(line)) return clean;
  if (/^\s*\*\*[^*]+\*\*\s*:?[ \t]*$/.test(line) && !/[.!?]$/.test(clean)) return clean;
  return requirementLabel.test(clean) ||
    /^(job description|about (?:the|this) role|the role|responsibilities|what you(?:'ll| will) do|benefits|compensation|location|employment type)$/.test(
      clean,
    )
    ? clean
    : null;
}

export interface RoleContent {
  description: string;
  requirements: string[];
}

export function extractRoleContent(value: string): RoleContent {
  const structured = value
    .slice(0, 60_000)
    .replace(
      /\b((?:(?:Minimum|Required|Basic|Essential|Preferred|Desired)\s+)?(?:Qualifications|Requirements))\s*:?\s+(?=(?:Candidates|Applicants|You|Must|Bachelor|Master|Degree|Experience|Proficien|Valid)\b)/g,
      '\n\n## $1\n\n',
    )
    .replace(/\bCompany Description\s+(?=[A-Z])/g, '\n\n## Company Description\n\n');
  const lines = structured.split(/\r?\n/);
  const sections = lines.flatMap((line, index) => {
    const name = heading(line);
    return name ? [{ name, index, depth: line.match(/^\s*(#{1,6})\s/)?.[1]?.length || 0 }] : [];
  });
  const sectionLines = (index: number) =>
    lines.slice(sections[index].index + 1, sections[index + 1]?.index ?? lines.length);
  const descriptionPriority = (name: string) =>
    /^what you(?:'ll| will) do$/.test(name)
      ? 0
      : /^(about (?:the|this) role|the role)$/.test(name)
        ? 1
        : name === 'job description'
          ? 2
          : name === 'responsibilities'
            ? 3
            : 99;
  const choices = sections
    .map((section, index) => ({ ...section, offset: index }))
    .filter((section) => descriptionPriority(section.name) < 99)
    .sort((a, b) => descriptionPriority(a.name) - descriptionPriority(b.name) || b.depth - a.depth);
  let description = '';
  for (const choice of choices) {
    const content = sectionLines(choice.offset)
      .filter(
        (line) =>
          !excluded.test(plainText(line)) && !/^\s*\./.test(line) && plainText(line).length > 1,
      )
      .join('\n');
    description = boundedProse(content);
    if (description) break;
  }
  const requirements: string[] = [];
  for (let i = 0; i < sections.length; i++) {
    if (!requirementLabel.test(sections[i].name)) continue;
    const entries = sectionLines(i).filter(
      (line) =>
        !excluded.test(plainText(line)) &&
        !/qualifications below|experience may be gained through/i.test(line),
    );
    const bullets = entries.filter((line) => /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line));
    const selected = bullets.length
      ? bullets
      : entries
          .flatMap(sourceSentences)
          .filter((line) =>
            /\b(must|require(?:d|ment|ments)?|degree|proficien(?:t|cy)|experience|familiar|ability|knowledge|enrolled|pursuing|authorized)\b/i.test(
              line,
            ),
          );
    for (const entry of selected) {
      const requirement = boundedProse(entry, 350);
      if (!requirement || requirement.length < 8) continue;
      const qualified = /^preferred|^desired/.test(sections[i].name)
        ? `Preferred: ${requirement}`
        : requirement;
      if (!requirements.includes(qualified)) requirements.push(qualified);
      if (requirements.length === 8) return { description, requirements };
    }
  }
  return { description, requirements };
}

export function sourceCompanyCase(company: string, source: string): string {
  if (!company || company !== company.toLowerCase()) return company;
  const escaped = company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [...source.slice(0, 60_000).matchAll(new RegExp(`\\b${escaped}\\b`, 'gi'))];
  return matches.find((match) => /[A-Z]/.test(match[0]))?.[0] || company;
}
