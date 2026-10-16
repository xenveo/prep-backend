// Deterministic LLM for tests and local dev (LLM_PROVIDER=fake). Canned outputs per request tag pass
// the schemas in modules/ai/schemas.ts. Tests can queue exact outputs or errors with setNext.
import type {
  LlmAdapter,
  LlmJsonRequest,
  LlmJsonResult,
} from './llm.adapter.js';

const CATEGORIES = [
  'behavioural',
  'situational',
  'role_knowledge',
  'motivation',
] as const;

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

export class FakeLlmAdapter implements LlmAdapter {
  readonly provider = 'fake';
  /** Every request received, in order. */
  readonly calls: LlmJsonRequest[] = [];
  private readonly queue = new Map<string, unknown[]>();

  /** Queues the next output (or thrown Error) for a tag. Queued items are used before canned ones. */
  setNext(tag: string, output: unknown): void {
    const list = this.queue.get(tag) ?? [];
    list.push(output);
    this.queue.set(tag, list);
  }

  reset(): void {
    this.calls.length = 0;
    this.queue.clear();
  }

  async json(req: LlmJsonRequest): Promise<LlmJsonResult> {
    this.calls.push(req);
    const queued = this.queue.get(req.tag);
    const next = queued?.length ? queued.shift() : canned(req);
    if (next instanceof Error) throw next;
    const raw = JSON.stringify(next);
    const input =
      req.system.length +
      req.messages.reduce((n, m) => n + m.content.length, 0);
    return {
      output: next,
      raw,
      provider: this.provider,
      model: req.model,
      usage: {
        inputTokens: Math.ceil(input / 4),
        outputTokens: Math.ceil(raw.length / 4),
        latencyMs: 0,
        costUsd: 0,
      },
    };
  }
}

function firstUserMessage(req: LlmJsonRequest): string {
  return req.messages.filter((m) => m.role === 'user')[0]?.content ?? '';
}

function canned(req: LlmJsonRequest): unknown {
  const user = firstUserMessage(req);
  switch (req.tag) {
    case 'evaluator':
      return evaluator(user);
    case 'evaluator_detail':
      return evaluatorDetail(user);
    case 'summariser':
      return summariser(user);
    case 'interviewer':
      return { text: "Let's begin with the first question." };
    case 'draft-cards':
      return draftCards(user);
    case 'draft-questions':
      return draftQuestions(user);
    default:
      throw new Error(
        `FakeLlmAdapter has no canned output for tag "${req.tag}"`,
      );
  }
}

function answerWords(user: string): string[] {
  const answer =
    /<candidate_answer>\n?([\s\S]*?)\n?<\/candidate_answer>/.exec(user)?.[1] ??
    '';
  return answer.split(/\s+/).filter(Boolean);
}

/** Levels grow with answer length so tests can see different scores. */
function evaluator(user: string) {
  const words = answerWords(user);
  const level =
    words.length < 20 ? 2 : words.length < 60 ? 3 : words.length < 120 ? 4 : 5;
  const points = [
    ...user.matchAll(/<improvement_point>([\s\S]*?)<\/improvement_point>/g),
  ].map((m) => unescapeXml(m[1]));
  return {
    dimension_scores: {
      content: level,
      structure: Math.max(1, level - 1),
      delivery: level,
      relevance: Math.min(5, level + 1),
    },
    worked: [
      'You gave a real example from your own work.',
      'Your tone was calm and friendly.',
    ],
    improve: ['Name the result at the end in one sentence.'],
    opener: 'In my last role, a customer was upset about…',
    improvement_points: ['End with the result', "Say 'I' not 'we'"],
    delivery_notes: 'A steady pace that is easy to follow.',
    follow_up: null,
    ...(points.length
      ? {
          applied: points.map((point) => ({
            point,
            status: words.length >= 60 ? 'applied' : 'partly',
            evidence:
              words.length >= 60
                ? 'You did this clearly.'
                : 'You did this in places.',
          })),
        }
      : {}),
  };
}

function evaluatorDetail(user: string) {
  const quote = answerWords(user).slice(0, 8).join(' ') || 'No answer';
  return {
    spoken_summary:
      'Nice work. You used a real example. Next time, end with the result.',
    highlights: [
      { quote, kind: 'match', note: 'Clear opening.', rubric_point_id: 'kp1' },
    ],
    evidence: [
      { dimension: 'content', quote, note: 'Shows the main example.' },
    ],
  };
}

function summariser(user: string) {
  const positions = [...user.matchAll(/<question position="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
  const at = (list: number[], i: number) =>
    list.length ? list[i % list.length] : 1;
  const reversed = [...positions].reverse();
  return {
    strengths: [0, 1, 2].map((i) => ({
      text: `Clear, specific example (${i + 1}).`,
      question_position: at(positions, i),
    })),
    focus_areas: [0, 1, 2].map((i) => ({
      text: `End each answer with the result (${i + 1}).`,
      question_position: at(reversed, i),
    })),
  };
}

const countFrom = (user: string) =>
  Number(/Number to draft: (\d+)/.exec(user)?.[1] ?? 3);

function draftCards(user: string) {
  return {
    cards: Array.from({ length: countFrom(user) }, (_, i) => ({
      category: CATEGORIES[i % CATEGORIES.length],
      question: `Practice question ${i + 1}: tell me about a time you solved a problem.`,
      strong_answer_points: ['A real situation', 'What you did', 'The result'],
      common_mistakes: ['Saying "we" for everything', 'No clear result'],
      tip: 'Keep it to about a minute.',
    })),
  };
}

function draftQuestions(user: string) {
  const cards = [...user.matchAll(/<card position="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
  return {
    questions: Array.from({ length: countFrom(user) }, (_, i) => ({
      text: `Interview question ${i + 1}: walk me through how you handled a difficult situation.`,
      category: CATEGORIES[i % CATEGORIES.length],
      difficulty: 'medium',
      card_position: cards.length ? cards[i % cards.length] : null,
      rubric: {
        key_points: [
          {
            point: 'Describes the situation',
            example: 'A customer was waiting for a refund',
          },
        ],
        red_flags: ['Blames others'],
        expected_structure: 'star',
      },
    })),
  };
}
