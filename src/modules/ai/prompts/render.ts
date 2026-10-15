// Prompt rendering (plan §6 "Prompts"). `{{var}}` placeholders take XML-escaped values; there are no
// loops or conditionals, so callers pass pre-joined strings. Candidate text never goes through a
// template: it is wrapped with wrapCandidateText and sent in the user message.

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

export function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);
}

/** Replaces `{{name}}` with the escaped value. Unknown placeholders render as empty strings. */
export function renderTemplate(
  template: string,
  vars: Record<string, string | number>,
): string {
  return template.replace(
    /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g,
    (_, name: string) => {
      const value = vars[name];
      return value === undefined ? '' : escapeXml(String(value));
    },
  );
}

export const CANDIDATE_TAG = 'candidate_answer';

// Any opening or closing candidate_answer tag, however spaced or cased.
const CANDIDATE_TAG_PATTERN = /<\s*\/?\s*candidate_answer\b[^>]*>/gi;

/**
 * Puts candidate text inside `<candidate_answer>` delimiters. Any delimiter tag inside the text is
 * neutralised first, so the text cannot close the block and smuggle instructions after it.
 */
export function wrapCandidateText(text: string): string {
  const safe = text.replace(CANDIDATE_TAG_PATTERN, '[tag removed]');
  return `<${CANDIDATE_TAG}>\n${safe}\n</${CANDIDATE_TAG}>`;
}
