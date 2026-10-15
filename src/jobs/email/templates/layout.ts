// Shared pieces for email templates: HTML escaping and a minimal inline-styled layout.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string | number): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

export type Block =
  { p: string; muted?: boolean } | { button: string; href: string };

/** Renders blocks of plain text (escaped here) into both the text and HTML bodies. */
export function render(
  subject: string,
  blocks: Block[],
): { subject: string; text: string; html: string } {
  const text = blocks
    .map((b) => ('p' in b ? b.p : `${b.button}: ${b.href}`))
    .join('\n\n');
  const body = blocks
    .map((b) =>
      'p' in b
        ? `<p style="margin:0 0 12px;${b.muted ? 'color:#6b7280;' : ''}">${escapeHtml(b.p)}</p>`
        : `<p style="margin:16px 0;"><a href="${escapeHtml(b.href)}" style="display:inline-block;background:#1f4fd8;color:#ffffff;padding:8px 14px;border-radius:6px;font-weight:600;text-decoration:none;">${escapeHtml(b.button)}</a></p>`,
    )
    .join('');
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>` +
    `<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#111827;">` +
    `<div style="max-width:520px;">${body}</div></body></html>`;
  return { subject, text, html };
}
