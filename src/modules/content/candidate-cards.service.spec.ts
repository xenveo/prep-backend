import type { PrismaService } from '../../prisma/prisma.service.js';
import type { ActivityService } from '../activity/activity.service.js';
import type { AssignmentsService } from '../users/assignments.service.js';
import { CandidateCardsService } from './candidate-cards.service.js';
import type { ContentQueryService } from './content-query.service.js';
import type { TtsCacheService } from './tts-cache.service.js';

function card(position: number, viewed = false) {
  return {
    id: `card-${position}`,
    position,
    category: 'role_knowledge',
    question: `Q${position}`,
    strongAnswerPoints: ['s'],
    commonMistakes: ['m'],
    tip: 't',
    views: viewed ? [{ userId: 'u1' }] : [],
  };
}

function setup(opts: { inserted?: number; total?: number; viewed?: number }) {
  const prisma = {
    flashCard: {
      findMany: vi.fn().mockResolvedValue([card(1, true), card(2)]),
      findFirst: vi.fn().mockResolvedValue(card(2)),
    },
    cardView: {
      createMany: vi.fn().mockResolvedValue({ count: opts.inserted ?? 1 }),
    },
  };
  const assignments = {
    findCandidateRole: vi.fn().mockResolvedValue({ role: { id: 'role-1' } }),
  };
  const activity = {
    list: vi.fn().mockResolvedValue([]),
    record: vi.fn().mockResolvedValue(undefined),
  };
  const tts = {
    getOrCreate: vi.fn().mockResolvedValue({ key: 'tts/k.mp3', durationS: 1 }),
    signedUrl: vi.fn().mockResolvedValue('https://signed'),
  };
  const content = {
    approvedCardCount: vi.fn().mockResolvedValue(opts.total ?? 2),
    viewedApprovedCardCount: vi.fn().mockResolvedValue(opts.viewed ?? 2),
  };
  const service = new CandidateCardsService(
    prisma as unknown as PrismaService,
    assignments as unknown as AssignmentsService,
    activity as unknown as ActivityService,
    tts as unknown as TtsCacheService,
    content as unknown as ContentQueryService,
  );
  return { service, prisma, activity, tts, assignments };
}

describe('CandidateCardsService', () => {
  it('lists cards in the candidate shape with viewed positions', async () => {
    const { service } = setup({});
    const r = await service.list('u1', 'support');
    expect(r.viewed).toEqual([1]);
    expect(r.cards[0]).toEqual({
      id: 1,
      category: 'Role knowledge',
      question: 'Q1',
      strong: ['s'],
      tip: 't',
      mistakes: ['m'],
    });
  });

  it('logs "Studied N of N" when the last card is viewed', async () => {
    const { service, activity } = setup({});
    await service.view('u1', 'support', 2);
    expect(activity.record).toHaveBeenCalledWith(
      'u1',
      'Studied 2 of 2 flash cards',
    );
  });

  it('does not log twice', async () => {
    const { service, activity } = setup({});
    activity.list.mockResolvedValue([
      { text: 'Studied 2 of 2 flash cards', at: '' },
    ]);
    await service.view('u1', 'support', 2);
    expect(activity.record).not.toHaveBeenCalled();
  });

  it('is a no-op for a repeat view or an unfinished set', async () => {
    const repeat = setup({ inserted: 0 });
    await repeat.service.view('u1', 'support', 2);
    const partial = setup({ viewed: 1 });
    await partial.service.view('u1', 'support', 2);
    expect(repeat.activity.record).not.toHaveBeenCalled();
    expect(partial.activity.record).not.toHaveBeenCalled();
  });

  it('404s for an unknown card position', async () => {
    const { service, prisma } = setup({});
    prisma.flashCard.findFirst.mockResolvedValue(null);
    await expect(service.view('u1', 'support', 9)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('returns a signed url for card audio, 503 when TTS fails', async () => {
    const { service, tts } = setup({});
    await expect(service.audioUrl('u1', 'support', 2)).resolves.toBe(
      'https://signed',
    );
    expect(tts.getOrCreate).toHaveBeenCalledWith('Q2');
    tts.getOrCreate.mockRejectedValue(new Error('down'));
    await expect(service.audioUrl('u1', 'support', 2)).rejects.toMatchObject({
      code: 'ai_unavailable',
      status: 503,
    });
  });
});
