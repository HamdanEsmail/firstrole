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

const label = (line: string) =>
  plainText(line)
    .replace(/[’‘]/g, "'")
    .replace(/[:\s]+$/, '')
    .toLowerCase();
const requirementLabel =
  /^(?:(?:minimum|required|preferred|basic|essential|desired)\s+)?(?:qualifications?|requirements?|skills(?: and experience)?)$|^what (?:you bring|you'll bring|you will bring|you need|we're looking for)|^who you are$|^must haves?$/i;
const excluded =
  /cookie|privacy notice|skip to (?:main )?content|page is loaded|tailored advertising|sign (?:in|up)|equal opportunity|employment decisions|recruitment fraud|fraudulent recruitment|all rights reserved|^apply(?: now)?$|^welcome[!.]?$|^share (?:this )?job|^save (?:this )?job/i;

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
  const lines = value.slice(0, 60_000).split(/\r?\n/);
  const sections = lines.flatMap((line, index) => {
    const name = heading(line);
    return name ? [{ name, index }] : [];
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
    .sort((a, b) => descriptionPriority(a.name) - descriptionPriority(b.name));
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
      : entries.filter((line) =>
          /\b(must|require|degree|proficien|experience|familiar|ability|knowledge|enrolled|pursuing|authorized)\b/i.test(
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
