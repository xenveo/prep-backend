// Transactional email templates. Candidate-invite copy follows the admin UI's invite preview
// (prep-admin-ui src/features/settings/email-section.tsx).
import { joinList, render } from './layout.js';

export type EmailVars = {
  'login-code': { code: string; minutes: number };
  'candidate-invite': {
    name: string;
    link: string;
    expiresDays: number;
    roleTitles: string[];
  };
  'admin-invite': {
    link: string;
    access: 'admin' | 'super_admin';
    expiresDays: number;
  };
  'role-assigned': { name: string; roleTitle: string; link: string };
  'session-complete': {
    name: string;
    roleTitle: string;
    score: number;
    link: string;
  };
  'export-ready': { link: string; expiresHours: number };
  'erasure-complete': Record<string, never>;
};

export type EmailTemplate = keyof EmailVars;

export type EmailJob = {
  [T in EmailTemplate]: { template: T; to: string; vars: EmailVars[T] };
}[EmailTemplate];

export type RenderedEmail = { subject: string; text: string; html: string };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const greeting = (name: string) => `Hi ${name.trim() || 'there'},`;

const TEMPLATES: {
  [T in EmailTemplate]: (vars: EmailVars[T]) => RenderedEmail;
} = {
  'login-code': ({ code, minutes }) =>
    render('Your PrepPilot login code', [
      { p: `Your login code is ${code}.` },
      { p: `It expires in ${plural(minutes, 'minute')} and works once.` },
      {
        p: 'If you didn’t try to log in, you can ignore this email.',
        muted: true,
      },
    ]),

  'candidate-invite': ({ name, link, expiresDays, roleTitles }) =>
    render('You’re invited to practise for your interview', [
      { p: greeting(name) },
      {
        p: `You’ve been invited to prepare for the ${joinList(roleTitles) || 'upcoming'} interview with short flash cards and a voice mock interview. You’ll get feedback after every answer.`,
      },
      { button: 'Log in to start', href: link },
      {
        p: `This link is just for you. It expires in ${plural(expiresDays, 'day')}.`,
        muted: true,
      },
    ]),

  'admin-invite': ({ link, access, expiresDays }) =>
    render('You’re invited to the PrepPilot admin', [
      { p: 'Hi there,' },
      {
        p: `You’ve been invited to help run interview practice on PrepPilot as ${access === 'super_admin' ? 'a super admin' : 'an admin'}.`,
      },
      { button: 'Accept invite', href: link },
      {
        p: `This link is just for you. It expires in ${plural(expiresDays, 'day')}.`,
        muted: true,
      },
    ]),

  'role-assigned': ({ name, roleTitle, link }) =>
    render(`You can now practise for the ${roleTitle} interview`, [
      { p: greeting(name) },
      {
        p: `You’ve been invited to prepare for the ${roleTitle} interview with short flash cards and a voice mock interview. You’ll get feedback after every answer.`,
      },
      { button: 'Log in to start', href: link },
    ]),

  'session-complete': ({ name, roleTitle, score, link }) =>
    render(`Your ${roleTitle} practice results`, [
      { p: greeting(name) },
      {
        p: `You finished a ${roleTitle} practice interview and scored ${score}.`,
      },
      { button: 'See your feedback', href: link },
    ]),

  'export-ready': ({ link, expiresHours }) =>
    render('Your PrepPilot export is ready', [
      { p: 'Your export has finished.' },
      { button: 'Get your export', href: link },
      {
        p: `It’s available for ${plural(expiresHours, 'hour')}.`,
        muted: true,
      },
    ]),

  'erasure-complete': () =>
    render('Your PrepPilot data has been deleted', [
      { p: 'Hi there,' },
      {
        p: 'Your PrepPilot account and practice data, including recordings, transcripts and scores, have been permanently deleted.',
      },
      { p: 'This is the last email you’ll get from us.', muted: true },
    ]),
};

export function renderEmail<T extends EmailTemplate>(
  template: T,
  vars: EmailVars[T],
): RenderedEmail {
  const fn = TEMPLATES[template] as (v: EmailVars[T]) => RenderedEmail;
  return fn(vars);
}
