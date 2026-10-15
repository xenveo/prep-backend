import { InterviewerService } from './interviewer.service.js';

describe('InterviewerService', () => {
  const service = new InterviewerService();

  it('greets by first name', () => {
    expect(
      service.intro({
        roleTitle: 'Customer Support',
        candidateName: 'Priya Sharma',
        questionCount: 5,
      }),
    ).toBe(
      "Hi Priya, welcome to your practice interview for the Customer Support role. I'll ask you 5 questions. After each answer you'll get feedback and one chance to try again. Take your time. Let's begin.",
    );
    expect(
      service.intro({ roleTitle: 'X', candidateName: ' ', questionCount: 1 }),
    ).toContain(
      "Hi, welcome to your practice interview for the X role. I'll ask you one question.",
    );
  });

  it('names the focus points on the retry', () => {
    expect(
      service.retryPrompt({
        focus: ['End with the result', "Say 'I'", 'Slow down'],
      }),
    ).toBe(
      "Let's try that one again. This time, focus on: End with the result, Say 'I' and Slow down. Take a moment, then start when you're ready.",
    );
    expect(service.retryPrompt({ focus: [] })).toBe(
      "Let's try that one again. Take a moment, then start when you're ready.",
    );
  });

  it('moves to the next question or to the results', () => {
    expect(service.transition({ nextPosition: 2, questionCount: 5 })).toBe(
      "Thanks. Here's question 2 of 5.",
    );
    expect(service.transition({ nextPosition: 6, questionCount: 5 })).toContain(
      'last question',
    );
  });
});
