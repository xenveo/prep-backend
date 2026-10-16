import type { GeminiClient } from '../gemini/gemini.client.js';
import { GeminiError } from '../gemini/gemini.errors.js';
import type {
  LlmAdapter,
  LlmJsonRequest,
  LlmJsonResult,
} from './llm.adapter.js';
import { LlmUnavailableError } from './llm.adapter.js';

/** Thinking tokens count against the output limit, so this leaves room for both. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

/** gemini-3.8-flash (plan 01-gemini "LLM adapter"). Model, temperature and thinking come from the prompt version. */
export class GeminiLlmAdapter implements LlmAdapter {
  readonly provider = 'gemini';

  constructor(private readonly gemini: GeminiClient) {}

  async json(req: LlmJsonRequest): Promise<LlmJsonResult> {
    let result;
    try {
      result = await this.gemini.generateJson({
        model: req.model,
        systemInstruction: req.system,
        contents: req.messages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        jsonSchema: req.jsonSchema,
        temperature: req.temperature,
        maxOutputTokens: req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        thinkingLevel: req.thinkingLevel,
      });
    } catch (err) {
      const code = err instanceof GeminiError ? err.code : 'unknown';
      throw new LlmUnavailableError(
        `Gemini call failed (${req.tag}): ${code}`,
        err,
      );
    }

    let output: unknown = null;
    try {
      output = JSON.parse(result.text);
    } catch {
      // Left null: the caller's Zod validation fails and it retries with `raw`.
    }
    return {
      output,
      raw: result.text,
      provider: this.provider,
      model: req.model,
      usage: result.usage,
    };
  }
}
