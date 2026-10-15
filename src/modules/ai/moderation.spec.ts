import { findHiringVerdict } from './moderation.js';

describe('findHiringVerdict', () => {
  it.each([
    'Great answer, you would be hired!',
    "Honestly YOU'RE HIRED.",
    'We would not hire on this basis.',
    'I would reject this answer.',
    'You are not a fit for the role yet.',
    'You’re hired.',
  ])('flags %s', (text) => {
    expect(findHiringVerdict(text)).not.toBeNull();
  });

  it.each([
    'Name the result at the end.',
    'The refund was rejected by the bank, and you explained it well.',
    'You fit a lot into a short answer.',
  ])('allows %s', (text) => {
    expect(findHiringVerdict(text)).toBeNull();
  });
});
