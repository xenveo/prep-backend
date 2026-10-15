import { neutraliseFormula, toCsv } from './csv.js';
import {
  csvDateTime,
  daysSince,
  formatDuration,
  inviteSentLabel,
  relativeTime,
} from './format.js';

// 2026-10-15 11:30 IST
const NOW = new Date('2026-10-15T06:00:00Z');

describe('relativeTime (IST wall clock)', () => {
  it('formats today, yesterday, days ago and older dates', () => {
    expect(relativeTime(new Date('2026-10-15T05:12:00Z'), NOW)).toBe(
      'Today 10:42',
    );
    // 23:00 IST on the 14th, though the UTC date is also the 14th
    expect(relativeTime(new Date('2026-10-14T17:30:00Z'), NOW)).toBe(
      'Yesterday',
    );
    // 01:00 IST on the 15th is today even though it is the 14th in UTC
    expect(relativeTime(new Date('2026-10-14T19:30:00Z'), NOW)).toBe(
      'Today 01:00',
    );
    expect(relativeTime(new Date('2026-10-02T06:00:00Z'), NOW)).toBe(
      '13 days ago',
    );
    expect(relativeTime(new Date('2026-10-01T06:00:00Z'), NOW)).toBe('1 Oct');
    expect(relativeTime(new Date('2025-10-01T06:00:00Z'), NOW)).toBe(
      '1 Oct 2025',
    );
  });

  it('labels invites', () => {
    expect(inviteSentLabel(new Date('2026-10-13T06:00:00Z'), NOW)).toBe(
      'Invite sent 2 days ago',
    );
    expect(inviteSentLabel(NOW, NOW)).toBe('Invite sent today');
    expect(inviteSentLabel(new Date('2026-09-01T06:00:00Z'), NOW)).toBe(
      'Invite sent on 1 Sep',
    );
  });

  it('counts calendar days', () => {
    expect(daysSince(new Date('2026-10-01T18:29:00Z'), NOW)).toBe(14);
    expect(daysSince(new Date('2026-10-01T18:31:00Z'), NOW)).toBe(13);
  });

  it('prints CSV date-times in IST', () => {
    expect(csvDateTime(new Date('2026-10-15T05:12:00Z'))).toBe(
      '2026-10-15 10:42',
    );
  });
});

describe('formatDuration', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatDuration(98)).toBe('1:38');
    expect(formatDuration(3723)).toBe('1:02:03');
    expect(formatDuration(-4)).toBe('0:00');
  });
});

describe('toCsv', () => {
  it('uses CRLF, quotes as needed and neutralises formulas', () => {
    expect(toCsv([['a', 'b,c', null], [], ['x\ny', 3, '=SUM(A1)', '-5']])).toBe(
      'a,"b,c",\r\n\r\n"x\ny",3,\'=SUM(A1),-5\r\n',
    );
    expect(neutraliseFormula('@cmd')).toBe("'@cmd");
    expect(neutraliseFormula('+12.5')).toBe('+12.5');
  });
});
