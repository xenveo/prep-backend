import {
  isValidEmail,
  summariseInviteRows,
  validateInviteRows,
} from './invite-validation.js';

const ctx = {
  approvedRoleNames: ['Customer Support Associate', 'Junior Data Analyst'],
  draftRoleNames: ['Store Manager'],
  existingEmails: ['Taken@Example.com'],
};

const row = (email: string, roles: string[] = ['Junior Data Analyst']) => ({
  email,
  name: ' Neha Kapoor ',
  roles,
});

describe('validateInviteRows', () => {
  it('accepts a good row, trimming and matching roles case-insensitively', () => {
    const [r] = validateInviteRows(
      [row(' neha@example.com ', [' customer support associate '])],
      ctx,
    );
    expect(r).toEqual({
      rowNumber: 1,
      email: 'neha@example.com',
      name: 'Neha Kapoor',
      roles: ['customer support associate'],
      result: 'ready',
    });
  });

  it('reports each problem with its cell, first problem winning', () => {
    const rows = validateInviteRows(
      [
        row('not-an-email', ['Nope']),
        row('taken@example.com'),
        row('a@example.com'),
        row('A@example.com'),
        row('b@example.com', ['Nope']),
        row('c@example.com', ['Store Manager']),
        row('d@example.com', []),
        row('e@example.com', ['Junior Data Analyst', 'store manager']),
      ],
      ctx,
    );
    expect(rows.map((r) => [r.result, r.problemCell, r.badRole])).toEqual([
      ['invalid_email', 'email', undefined],
      ['already_invited', 'email', undefined],
      ['ready', undefined, undefined],
      ['duplicate_in_file', 'email', undefined],
      ['unknown_role', 'roles', 'Nope'],
      ['role_not_approved', 'roles', 'Store Manager'],
      ['unknown_role', 'roles', ''],
      ['role_not_approved', 'roles', 'store manager'],
    ]);
    expect(rows.map((r) => r.rowNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(summariseInviteRows(rows)).toEqual({
      total: 8,
      ready: 1,
      needFixing: 7,
    });
  });

  it('flags a repeat of an existing email as a duplicate the second time', () => {
    const rows = validateInviteRows(
      [row('taken@example.com'), row('taken@example.com')],
      ctx,
    );
    expect(rows.map((r) => r.result)).toEqual([
      'already_invited',
      'already_invited',
    ]);
  });
});

it('isValidEmail matches the admin UI rule', () => {
  expect(isValidEmail('a@b.co')).toBe(true);
  expect(isValidEmail('a@b')).toBe(false);
  expect(isValidEmail('a b@c.de')).toBe(false);
  expect(isValidEmail('a@b.c;d')).toBe(false);
});
