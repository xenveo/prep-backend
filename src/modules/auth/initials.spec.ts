import { initialsFor } from './initials.js';

describe('initialsFor', () => {
  it('uses the first and last word of the name', () => {
    expect(initialsFor('Priya Kumari Shah', 'x@y.co')).toBe('PS');
    expect(initialsFor('  arjun  mehta ', 'x@y.co')).toBe('AM');
  });

  it('uses the first two letters of a single-word name', () => {
    expect(initialsFor('Priya', 'x@y.co')).toBe('PR');
  });

  it('falls back to the email local part', () => {
    expect(initialsFor(null, 'priya.shah@acme.com')).toBe('PS');
    expect(initialsFor(null, 'priya@acme.com')).toBe('PR');
    expect(initialsFor('', 'arjun_mehta@acme.com')).toBe('AM');
  });
});
