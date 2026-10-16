// Evaluator calibration run (SRS 5.5, plan 05-production-ops "Evaluator calibration").
//
//   node --env-file=.env --import tsx scripts/calibrate.ts <fixture.json> [--limit N] [--max-usd 1.00]
//
// Scores each human-scored answer with the real evaluator call 1 (the active 'evaluator' prompt
// version and model, the question's rubric and the workspace delivery targets from the database),
// then compares levels per dimension.
// Prints a markdown summary and writes `<fixture>.results-<timestamp>.json` next to the fixture.
// Never prints answer text or notes. Exit code: 0 pass, 1 fail, 2 invalid input or aborted.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { createLlmAdapter } from '../src/adapters/adapters.module.js';
import { GeminiClient } from '../src/adapters/gemini/gemini.client.js';
import type {
  LlmAdapter,
  LlmJsonRequest,
  LlmJsonResult,
} from '../src/adapters/llm/llm.adapter.js';
import { AppError } from '../src/common/errors/app-error.js';
import { formatZodIssues } from '../src/common/validation/zod.pipe.js';
import { loadConfig } from '../src/config/app-config.js';
import { AiCallLogService } from '../src/modules/ai/ai-call-log.service.js';
import {
  EvaluatorService,
  type EvaluateInput,
} from '../src/modules/ai/evaluator.service.js';
import { PromptService } from '../src/modules/ai/prompt.service.js';
import type { RoleSettings, Rubric } from '../src/modules/interview/types.js';
import { SettingsService } from '../src/modules/settings/settings.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';
import {
  calibrationFixtureSchema,
  estimateCallUsd,
  renderMarkdown,
  summarise,
  type CalibrationItem,
  type ItemResult,
  type RunInfo,
} from './calibration.js';

class BudgetExceededError extends Error {}

/** Sums provider-reported cost and refuses a call that would take the run past `maxUsd`. */
class MeteredLlm implements LlmAdapter {
  readonly provider: string;
  spentUsd = 0;
  calls = 0;
  unpricedCalls = 0;
  budgetHit = false;

  constructor(
    private readonly inner: LlmAdapter,
    private readonly maxUsd: number,
  ) {
    this.provider = inner.provider;
  }

  async json(req: LlmJsonRequest): Promise<LlmJsonResult> {
    const chars =
      req.system.length +
      req.messages.reduce((sum, m) => sum + m.content.length, 0);
    const next = estimateCallUsd(req.model, chars) ?? 0;
    if (this.spentUsd + next > this.maxUsd) {
      this.budgetHit = true;
      throw new BudgetExceededError('max-usd reached');
    }
    const result = await this.inner.json(req);
    this.calls++;
    if (result.usage.costUsd === null) this.unpricedCalls++;
    else this.spentUsd += result.usage.costUsd;
    return result;
  }
}

const argsSchema = z.object({
  fixture: z.string().min(1, 'usage: calibrate.ts <fixture.json>'),
  limit: z.coerce.number().int().positive().optional(),
  maxUsd: z.coerce.number().positive().default(1),
});

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    limit: { type: 'string' },
    'max-usd': { type: 'string' },
  },
});
const args = argsSchema.safeParse({
  fixture: positionals[0] ?? '',
  limit: values.limit,
  maxUsd: values['max-usd'],
});
if (!args.success) fail(formatZodIssues(args.error.issues));
const { fixture: fixturePath, limit, maxUsd } = args.data;

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(fixturePath, 'utf8'));
} catch (err) {
  fail(`Cannot read the fixture as JSON (${(err as Error).name})`);
}
const parsedFixture = calibrationFixtureSchema.safeParse(raw);
if (!parsedFixture.success)
  fail(`Invalid fixture: ${formatZodIssues(parsedFixture.error.issues)}`);
const fixture = parsedFixture.data;
const items = fixture.items.slice(0, limit);

const config = loadConfig();
const prisma = new PrismaService(config);
const llm = new MeteredLlm(
  createLlmAdapter(
    config.env,
    new GeminiClient({
      apiKey: config.env.GEMINI_API_KEY,
      timeoutMs: config.env.GEMINI_TIMEOUT_MS,
    }),
  ),
  maxUsd,
);
const prompts = new PromptService(prisma);
const evaluator = new EvaluatorService(
  llm,
  prompts,
  new AiCallLogService(prisma),
);

type Resolved = {
  item: CalibrationItem;
  index: number;
  questionId: string;
  input: EvaluateInput;
};

/** Every item's role and question, before any LLM call; a fixture that doesn't resolve fails fast. */
async function resolve(): Promise<Resolved[]> {
  const { deliveryTargets } = await new SettingsService(prisma).get();
  const resolved: Resolved[] = [];
  const missing: string[] = [];
  for (const [index, item] of items.entries()) {
    const role = await prisma.jobRole.findUnique({
      where: { slug: item.roleSlug },
    });
    const question = role
      ? await prisma.question.findFirst({
          where: {
            jobRoleId: role.id,
            ...(item.questionId
              ? { id: item.questionId }
              : { text: item.questionText }),
          },
          orderBy: { createdAt: 'asc' },
        })
      : null;
    if (!role || !question) {
      missing.push(`#${index} (${role ? 'question' : 'role'} not found)`);
      continue;
    }
    resolved.push({
      item,
      index,
      questionId: question.id,
      input: {
        roleTitle: role.title,
        question: question.text,
        rubric: question.rubric as Rubric,
        transcript: item.answerText,
        mode: item.mode,
        delivery: item.delivery ?? null,
        deliveryTargets,
        attemptNo: 1,
        dimensionWeights: (role.settings as RoleSettings).dimensionWeights,
      },
    });
  }
  if (missing.length) fail(`Unresolved fixture items: ${missing.join(', ')}`);
  return resolved;
}

/** Prompt size of one item: template, question, rubric and answer, plus the fixed user-message text. */
const itemEstimate = (r: Resolved, template: string, model: string) =>
  estimateCallUsd(
    model,
    template.length +
      r.input.question.length +
      JSON.stringify(r.input.rubric).length +
      r.input.transcript.length +
      600,
  );

async function main(): Promise<number> {
  const resolved = await resolve();
  const prompt = await prompts.getActive('evaluator');
  const estimates = resolved.map((r) =>
    itemEstimate(r, prompt.template, prompt.model),
  );
  const estimatedUsd = estimates.every((e) => e !== null)
    ? estimates.reduce((sum, e) => sum + e, 0)
    : null;
  const info: RunInfo = {
    fixture: basename(fixturePath),
    description: fixture.description,
    provider: llm.provider,
    evaluatorPrompt: {
      version: prompt.version,
      model: prompt.model,
      temperature: prompt.temperature,
      thinkingLevel: prompt.thinkingLevel,
    },
    promptVersionsSeen: [],
    selected: resolved.length,
    limit: limit ?? null,
    maxUsd,
    estimatedUsd,
    actualUsd: 0,
    calls: 0,
    unpricedCalls: 0,
    aborted: null,
  };
  console.error(
    `Calibrating ${resolved.length} answers, estimated ${estimatedUsd === null ? 'unknown' : `$${estimatedUsd.toFixed(4)}`} (max $${maxUsd})`,
  );
  if (estimatedUsd !== null && estimatedUsd > maxUsd)
    fail(
      `Estimated cost exceeds --max-usd ${maxUsd}; lower --limit or raise --max-usd.`,
    );

  const results: ItemResult[] = [];
  for (const [i, r] of resolved.entries()) {
    if (llm.spentUsd + (estimates[i] ?? 0) > maxUsd) llm.budgetHit = true;
    if (llm.budgetHit) {
      info.aborted = `max-usd reached before item #${r.index}; ${resolved.length - i} items not run`;
      break;
    }
    const base = {
      index: r.index,
      id: r.item.id ?? null,
      roleSlug: r.item.roleSlug,
      questionId: r.questionId,
      mode: r.item.mode,
      human: r.item.humanScores,
    };
    try {
      const out = await evaluator.evaluate(r.input);
      results.push({
        ...base,
        model: out.output.dimension_scores,
        promptVersion: out.promptVersion,
        error: null,
      });
    } catch (err) {
      if (llm.budgetHit) {
        info.aborted = `max-usd reached during item #${r.index}; ${resolved.length - i} items not run`;
        break;
      }
      results.push({
        ...base,
        model: null,
        promptVersion: null,
        error: err instanceof AppError ? err.code : 'error',
      });
    }
    console.error(`#${r.index} done (${i + 1}/${resolved.length})`);
  }

  info.actualUsd = llm.spentUsd;
  info.calls = llm.calls;
  info.unpricedCalls = llm.unpricedCalls;
  info.promptVersionsSeen = [
    ...new Set(results.flatMap((r) => r.promptVersion ?? [])),
  ].sort((a, b) => a - b);
  const report = summarise(results);
  const finishedAt = new Date().toISOString();
  const out = join(
    dirname(fixturePath),
    `${basename(fixturePath, '.json')}.results-${finishedAt.replace(/[:.]/g, '-')}.json`,
  );
  writeFileSync(
    out,
    JSON.stringify({ finishedAt, ...info, report, items: results }, null, 2) +
      '\n',
  );
  process.stdout.write(renderMarkdown(info, report, results));
  console.error(`Results written to ${out}`);
  if (info.aborted) return 2;
  return report.pass ? 0 : 1;
}

try {
  process.exitCode = await main();
} finally {
  await prisma.$disconnect();
}
