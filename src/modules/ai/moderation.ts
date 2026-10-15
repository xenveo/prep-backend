// Hiring-decision blocklist for model output (NFR-09, spec "Safety"). Candidates get coaching, never verdicts.

const BLOCKLIST: readonly string[] = [
  'you would be hired',
  "you'd be hired",
  'you will be hired',
  "you're hired",
  'you are hired',
  'we would hire you',
  'we would not hire',
  "we wouldn't hire",
  'would not be hired',
  "wouldn't be hired",
  'not be hired',
  'reject',
  'rejected for the role',
  'not a fit for the role',
  'not a good fit',
  'not the right fit',
  'not suitable for the role',
  'unsuitable for the role',
  'not hireable',
  'unhireable',
  'should not hire',
  'do not hire',
  "don't hire",
  'pass on this candidate',
  'shortlist',
];

const escapeRe = (s: string) =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "['’]");

const PATTERNS = BLOCKLIST.map((phrase) => ({
  phrase,
  re: new RegExp(`\\b${escapeRe(phrase).replace(/ /g, '\\s+')}\\b`, 'i'),
}));

/** Returns the first blocklisted phrase found (word boundaries, case-insensitive), or null. */
export function findHiringVerdict(text: string): string | null {
  return PATTERNS.find((p) => p.re.test(text))?.phrase ?? null;
}
