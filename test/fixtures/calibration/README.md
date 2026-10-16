# Evaluator calibration fixtures

`scripts/calibrate.ts` checks the evaluator against people (SRS 5.5, plan `05-production-ops.md` "Evaluator calibration"). It scores human-scored answers with the real evaluator and reports how often the two agree.

**Target:** at least 80% of answers within ±1 level on every dimension (content, structure, delivery, relevance), with at least 30 human-scored answers per role.

`sample.json` here is an **illustrative sample, not a calibration set**. Its 8 answers are synthetic, and a developer, not a subject-matter expert, assigned their scores. Use it to try the script and the format only. Its agreement numbers prove nothing.

A real calibration needs a set scored by subject-matter experts (SMEs), which only the product owner can supply. Keep that set outside this repo unless every answer is synthetic (see "Consent and privacy").

## Running

```
node --env-file=.env --import tsx scripts/calibrate.ts <fixture.json> [--limit N] [--max-usd 1.00]
```

- **Evaluator used:** the database in `DATABASE_URL` supplies the question rubrics and the active `evaluator` prompt version. `LLM_PROVIDER` picks the provider. Run it against the database and provider you are calibrating.
- **Call 1 only:** the script runs evaluator call 1, which produces the scores. Call 2 (spoken summary and highlights) does not change scores, so it is not run.
- **Typed answers:** every answer is scored as attempt 1. Typed answers get the typed-delivery instruction, so delivery is scored on the writing.
- **Cost guard:** the script prints an estimated cost first. It refuses to start if the estimate exceeds `--max-usd` (default 1.00). It stops before any call that would take the actual cost, as reported by the provider, past that limit. A full run of 90 answers costs about $0.15 to $0.30 at 2026 Gemini Flash prices.
- **Output:** a markdown summary on stdout and `<fixture>.results-<timestamp>.json` next to the fixture. The JSON holds the per-item levels, the metrics, the prompt version, model and cost. Neither output contains answer text or notes, only indexes, item ids, question ids and scores. Results files are gitignored.
- **Exit codes:** `0` pass, `1` fail (including too few answers), `2` invalid input or a run stopped by the cost guard.

Calls are logged to `ai_call_logs` like any other evaluator call, with no session.

**Re-run** whenever the evaluator prompt or model changes. Record the verdict and the within-±1 table in the new prompt version's notes.

## Fixture format

Use either a bare JSON array of items, or `{ "description": "...", "items": [...] }`.

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | no | Your label for the item, such as `cs-07`. It appears in reports, so never put answer text in it |
| `roleSlug` | yes | The role's slug, such as `customer-support-associate` |
| `questionId` or `questionText` | exactly one | The question. `questionText` must match the stored text exactly, which keeps fixtures portable between databases |
| `answerText` | yes | The answer, as typed or as transcribed from voice |
| `mode` | yes | `typed` or `voice` |
| `delivery` | no, voice only | Measured metrics: `{ wpm, fillerCount, pauseCount, longestPauseS, durationS }`. Without them, delivery is scored from the text |
| `humanScores` | yes | `{ content, structure, delivery, relevance }`, each an integer from 1 to 5 |
| `notes` | no | Scorer notes. Never printed or written to results |

The levels mean the same as in the evaluator prompt:

- **Content:** covers the rubric's key points with real detail.
- **Structure:** follows the expected structure (STAR, problem then solution, or free) and is easy to follow.
- **Delivery:** clear, confident and well paced; for typed answers, clear and concise writing.
- **Relevance:** answers the question that was asked.

Level 1 means missing and 5 means excellent.

## Collecting a calibration set

1. **Pick questions.** Use at least 30 answers per role, spread over that role's approved questions. Check each question's rubric first: the evaluator scores content against it, so a rubric that does not fit its question makes the run meaningless.
2. **Spread quality.** Aim for roughly equal numbers of strong, average and weak answers. Include off-topic, rambling, very short and non-native-English answers, and some voice transcripts with their delivery metrics.
3. **Score blind.** At least two SMEs score each answer on their own, from the rubric and the level definitions above, without seeing the AI's scores.
4. **Agree a level.** Where the SMEs differ by 2 or more, they discuss the answer and agree a level. Otherwise use the rounded mean. Record inter-rater agreement too: the evaluator can't be expected to beat it.
5. **Run once per role.** Then run the full set, and read the confusion summary as well as the verdict. A steady bias (for example, the model always one level harsher on structure) is a prompt fix, even when the run passes.

## Consent and privacy

Only synthetic answers, or answers whose authors gave explicit written consent for this use, may go into a fixture.

**Never put real candidate data in this repo.** That covers transcripts from production sessions, names, employers, emails and any other personal data (DPDP Act 2023).

Keep consented sets in access-controlled storage. Delete them when the consent or the calibration need ends.

Synthetic answers must not describe real, identifiable people.
