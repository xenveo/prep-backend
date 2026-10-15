// Date and label formatting for the admin read models, matching ../prep-admin-ui/src/lib/format.ts
// but against the real current time. Calendar days are counted on the wall clock in India time
// (the workspace is India-only, plan §13), so "Today" and "Yesterday" agree with what admins see.
import type { Band } from '../../generated/prisma/client.js';
import { toAdminBand, type AdminBand } from '../../common/mapping/enums.js';

export const WORKSPACE_TIME_ZONE = 'Asia/Kolkata';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

type Wall = { y: number; m: number; d: number; hh: number; mm: number };

const wallFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: WORKSPACE_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function wall(date: Date): Wall {
  const parts: Record<string, number> = {};
  for (const p of wallFormat.formatToParts(date))
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return {
    y: parts.year,
    m: parts.month,
    d: parts.day,
    hh: parts.hour,
    mm: parts.minute,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayNumber = (w: Pick<Wall, 'y' | 'm' | 'd'>) =>
  Math.floor(Date.UTC(w.y, w.m - 1, w.d) / 86_400_000);

/** "2026-10-15": a YYYY-MM-DD day parsed as a calendar date. */
function parseDay(day: string): Pick<Wall, 'y' | 'm' | 'd'> {
  const [y, m, d] = day.split('-').map(Number);
  return { y, m, d };
}

/** Today's calendar date in workspace time, "YYYY-MM-DD". */
export function workspaceDay(date: Date): string {
  const w = wall(date);
  return `${w.y}-${pad(w.m)}-${pad(w.d)}`;
}

/** "YYYY-MM-DD HH:mm" in workspace time (CSV "Last active"). */
export function csvDateTime(date: Date): string {
  const w = wall(date);
  return `${w.y}-${pad(w.m)}-${pad(w.d)} ${pad(w.hh)}:${pad(w.mm)}`;
}

/** `days` calendar days after `day` ("YYYY-MM-DD"). Negative goes back. */
export function addDays(day: string, days: number): string {
  const d = new Date(Date.UTC(...ymd(day)) + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function ymd(day: string): [number, number, number] {
  const { y, m, d } = parseDay(day);
  return [y, m - 1, d];
}

/** Midnight at the start of `day` in workspace time (IST is a fixed +05:30). */
export function startOfWorkspaceDay(day: string): Date {
  return new Date(`${day}T00:00:00+05:30`);
}

/** Whole calendar days from `date` to `now` (positive = in the past). */
export function daysSince(date: Date, now: Date): number {
  return dayNumber(wall(now)) - dayNumber(wall(date));
}

/** Whole calendar days between two "YYYY-MM-DD" days. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(parseDay(to)) - dayNumber(parseDay(from));
}

/** "15 Oct 2026" */
export function formatDay(day: string): string {
  const { y, m, d } = parseDay(day);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "15 Oct" */
function formatShortDay(day: string): string {
  const { m, d } = parseDay(day);
  return `${d} ${MONTHS[m - 1]}`;
}

/** "15 Sep – 15 Oct 2026" */
export function formatDayRange(from: string, to: string): string {
  const left =
    parseDay(from).y === parseDay(to).y
      ? formatShortDay(from)
      : formatDay(from);
  return `${left} – ${formatDay(to)}`;
}

/** "Today 10:42", "Yesterday", "2 days ago"; two weeks or older → "29 Sep" (or "29 Sep 2025"). */
export function relativeTime(date: Date, now: Date): string {
  const w = wall(date);
  const diff = daysSince(date, now);
  if (diff === 0) return `Today ${pad(w.hh)}:${pad(w.mm)}`;
  if (diff === 1) return 'Yesterday';
  if (diff > 1 && diff < 14) return `${diff} days ago`;
  const day = workspaceDay(date);
  return wall(now).y === w.y ? formatShortDay(day) : formatDay(day);
}

/** "today", "yesterday", "2 days ago", "on 29 Sep". */
function relativeDay(date: Date, now: Date): string {
  const diff = daysSince(date, now);
  if (diff <= 0) return 'today';
  if (diff === 1) return 'yesterday';
  if (diff < 14) return `${diff} days ago`;
  return `on ${formatShortDay(workspaceDay(date))}`;
}

/** "Invite sent 2 days ago" */
export function inviteSentLabel(sentAt: Date, now: Date): string {
  return `Invite sent ${relativeDay(sentAt, now)}`;
}

/** Seconds → "1:38" (or "1:02:03" past an hour). */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

export const BAND_LABEL: Record<AdminBand, string> = {
  ready: 'Interview ready',
  nearly: 'Nearly ready',
  developing: 'Developing',
  not_ready: 'Not ready yet',
};

export const bandLabel = (band: Band): string => BAND_LABEL[toAdminBand(band)];
