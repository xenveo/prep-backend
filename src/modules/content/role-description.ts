import sanitizeHtml from 'sanitize-html';

/** The admin rich-text editor's tag set (prep-admin-ui src/components/ui/rich-text-editor.tsx). */
const EDITOR_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: ['b', 'strong', 'i', 'em', 'ul', 'ol', 'li', 'p', 'br', 'a'],
  allowedAttributes: { a: ['href', 'rel'] },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  transformTags: {
    div: 'p',
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
  },
};

/** Server-side sanitising of the role description (spec: "HTML in description is sanitised server-side"). */
export function sanitizeDescription(html: string): string {
  return sanitizeHtml(html, EDITOR_OPTIONS).trim();
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

/** Plain text of a description for prompts (plan §7: "the description (HTML stripped)"). */
export function descriptionText(html: string): string {
  const withBreaks = html.replace(/<br\s*\/?>|<\/(p|li|div)>/gi, '\n');
  return sanitizeHtml(withBreaks, { allowedTags: [], allowedAttributes: {} })
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (e) => ENTITIES[e] ?? e)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}
