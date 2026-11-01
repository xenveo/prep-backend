import { escapeHtml, joinList } from './layout.js';
import { renderEmail } from './templates.js';

describe('escapeHtml', () => {
  it('escapes the five HTML specials', () => {
    expect(escapeHtml(`<a href="x">&'`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&amp;&#39;',
    );
  });
});

describe('joinList', () => {
  it('joins with commas and "and"', () => {
    expect(joinList([])).toBe('');
    expect(joinList(['A'])).toBe('A');
    expect(joinList(['A', 'B'])).toBe('A and B');
    expect(joinList(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('renderEmail', () => {
  it('login-code', () => {
    const m = renderEmail('login-code', { code: '123456', minutes: 10 });
    expect(m.subject).toBe('Your PrepPilot login code');
    expect(m.text).toContain('123456');
    expect(m.text).toContain('10 minutes');
    expect(m.html).toContain('123456');
  });

  it('candidate-invite uses the admin preview copy', () => {
    const m = renderEmail('candidate-invite', {
      name: 'Priya',
      link: 'https://app.example.com/invite?t=abc&x=1',
      expiresDays: 7,
      roleTitles: ['Customer Support Associate', 'Junior Data Analyst'],
    });
    expect(m.subject).toBe('You’re invited to practise for your interview');
    expect(m.text).toContain('Hi Priya,');
    expect(m.text).toContain(
      'prepare for the Customer Support Associate and Junior Data Analyst interview',
    );
    expect(m.text).toContain(
      'Log in to start: https://app.example.com/invite?t=abc&x=1',
    );
    expect(m.text).toContain('It expires in 7 days.');
    expect(m.html).toContain(
      'href="https://app.example.com/invite?t=abc&amp;x=1"',
    );
  });

  it('escapes candidate-supplied values in HTML but not in text', () => {
    const m = renderEmail('candidate-invite', {
      name: '<script>alert(1)</script>',
      link: 'https://x',
      expiresDays: 1,
      roleTitles: ['R&D'],
    });
    expect(m.html).not.toContain('<script>');
    expect(m.html).toContain('&lt;script&gt;');
    expect(m.html).toContain('R&amp;D');
    expect(m.text).toContain('Hi <script>alert(1)</script>,');
    expect(m.text).toContain('1 day.');
  });

  it('candidate-invite greets unnamed candidates', () => {
    expect(
      renderEmail('candidate-invite', {
        name: '',
        link: 'l',
        expiresDays: 7,
        roleTitles: [],
      }).text,
    ).toContain('Hi there,');
  });

  it('admin-invite names the access level', () => {
    expect(
      renderEmail('admin-invite', {
        link: 'l',
        access: 'super_admin',
        expiresDays: 7,
      }).text,
    ).toContain('as a super admin');
    expect(
      renderEmail('admin-invite', {
        link: 'l',
        access: 'admin',
        expiresDays: 7,
      }).text,
    ).toContain('as an admin');
  });

  it('role-assigned', () => {
    const m = renderEmail('role-assigned', {
      name: 'Ravi',
      roleTitle: 'Sales Development Rep',
      link: 'https://x',
    });
    expect(m.subject).toContain('Sales Development Rep');
    expect(m.text).toContain('Hi Ravi,');
  });

  it('session-complete', () => {
    const m = renderEmail('session-complete', {
      name: 'Ravi',
      roleTitle: 'SDR',
      score: 74,
      link: 'https://x',
    });
    expect(m.text).toContain('scored 74');
  });

  it('practice-reminder uses an ordinary login link and escapes the name', () => {
    const m = renderEmail('practice-reminder', {
      name: '<Ravi>',
      link: 'https://app.example.com/login',
    });
    expect(m.subject).toBe('Keep your interview practice going');
    expect(m.text).toContain('Hi <Ravi>,');
    expect(m.html).toContain('Hi &lt;Ravi&gt;,');
    expect(m.text).toContain(
      'Continue practising: https://app.example.com/login',
    );
    expect(m.text).not.toContain('token=');
  });

  it('export-ready', () => {
    expect(
      renderEmail('export-ready', { link: 'https://x', expiresHours: 24 }).text,
    ).toContain('24 hours');
  });

  it('erasure-complete', () => {
    const m = renderEmail('erasure-complete', {});
    expect(m.subject).toBe('Your PrepPilot data has been deleted');
    expect(m.html).toContain('<!doctype html>');
  });
});
