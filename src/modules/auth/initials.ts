const firstTwo = (s: string) => (s.slice(0, 2) || '?').toUpperCase();

/**
 * "Priya Shah" -> "PS"; with no name, "priya.shah@acme.com" -> "PS" (as the candidate UI derives it).
 * A single word gives its first two letters.
 */
export function initialsFor(name: string | null, email: string): string {
  const words = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (words.length > 1)
    return (words[0][0] + words[words.length - 1][0]).toUpperCase();
  if (words.length === 1) return firstTwo(words[0]);
  const local = email.split('@')[0] ?? '';
  const parts = local.split(/[._-]+/).filter(Boolean);
  return parts.length > 1
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : firstTwo(local);
}
