import { Injectable } from '@nestjs/common';

export type IntroInput = {
  roleTitle: string;
  candidateName: string;
  questionCount: number;
};
export type RetryPromptInput = { focus: string[] };
export type TransitionInput = { nextPosition: number; questionCount: number };

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? '';

function joinList(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * Interviewer lines (SRS 7.2 interviewer). R1 uses fixed templates, as plan §6 allows: they are
 * instant, cacheable for TTS, and cannot drift off-topic (FR-INT-08). The interviewer prompt in
 * prompt_versions is kept for a later LLM-driven version.
 */
@Injectable()
export class InterviewerService {
  intro(input: IntroInput): string {
    const name = firstName(input.candidateName);
    const greeting = name ? `Hi ${name}, welcome` : 'Hi, welcome';
    const count =
      input.questionCount === 1
        ? 'one question'
        : `${input.questionCount} questions`;
    return `${greeting} to your practice interview for the ${input.roleTitle} role. I'll ask you ${count}. After each answer you'll get feedback and one chance to try again. Take your time. Let's begin.`;
  }

  retryPrompt(input: RetryPromptInput): string {
    const focus = input.focus.map((f) => f.trim()).filter(Boolean);
    const tail = focus.length
      ? ` This time, focus on: ${joinList(focus)}.`
      : '';
    return `Let's try that one again.${tail} Take a moment, then start when you're ready.`;
  }

  transition(input: TransitionInput): string {
    if (input.nextPosition > input.questionCount) {
      return "That was the last question. Well done for finishing. Let's look at your results.";
    }
    return `Thanks. Here's question ${input.nextPosition} of ${input.questionCount}.`;
  }
}
