import { validationFailed } from '../../common/errors/app-error.js';

export function executivePeriod(period?: string, now = new Date()) {
  const current = now.toISOString().slice(0, 7);
  const selected = period ?? current;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selected) || selected < '2000-01')
    throw validationFailed(
      'Expected a reporting period in YYYY-MM from 2000 onwards',
    );
  if (selected > current)
    throw validationFailed('Reporting period cannot be in the future');
  const [year, month] = selected.split('-').map(Number);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const cohortStart = new Date(Date.UTC(year, month - 2, 1));
  const monthEnd = new Date(Date.UTC(year, month, 1));
  return {
    period: selected,
    cohortMonth: cohortStart.toISOString().slice(0, 7),
    start,
    cohortStart,
    cohortEnd: start,
    cutoff: new Date(Math.min(now.getTime(), monthEnd.getTime())),
    monthEnd,
    previousStart: cohortStart,
  };
}
export type ExecutivePeriod = ReturnType<typeof executivePeriod>;
