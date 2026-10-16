# 01 · Gemini: assessment, transcription and the interviewer voice

**The interview flow does not change.** R1 keeps the SRS/spec design: the AI asks the question with cached audio, the candidate records an answer, the browser **uploads it when the candidate finishes**, and then batch transcription, delivery metrics and the LLM evaluator run, followed by written feedback and spoken feedback. There's one retry, a comparison, and typed mode throughout. There is **no real-time voice conversation** in R1. The models are slotted into the existing adapter contracts, so services, the pipeline, the WebSocket events and both UIs keep their shape.

Two Gemini models, chosen by the user on 2026-10-16. The Live model was considered and dropped, because the interview stays record-then-upload.

| Model | Docs | Role in the existing flow | Adapter |
| --- | --- | --- | --- |
| **`gemini-3.8-flash`** (stable, Sep 2026) | [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash) | Evaluator (scores and feedback), summariser, drafter (cards/questions), admin test evaluation, **transcription of uploaded answers** | `LlmAdapter`, `SttAdapter` |
| **`gemini-3.8-flash-tts`** (Sep 2026) | [model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash-tts) | **The interviewer's voice:** question audio (pre-generated on role approval and cached), spoken feedback clips, card audio and admin voice samples | `TtsAdapter` |

No other models are used; `gemini-3.8-flash-lite-tts` is a cheaper fallback if cost requires it. SDK: `@google/genai`; the ATS backend uses `^2.14.0`, so check the installed version supports both models.

## Facts this design relies on

From the model pages, read 2026-10-16:

**`gemini-3.8-flash`**
- Input: text, image, video, **audio** and PDF. Output: text.
- Input limit 1,048,576 tokens, output 65,536.
- **Structured outputs** are supported.
- Thinking levels are `low`, `medium` and `high`. `minimal` is an error.

**`gemini-3.8-flash-tts`**
- Input: text (8,192 tokens). Output: audio (16,384 tokens).
- It's called with `generateContent`. Input text is treated as a **verbatim transcript**, so inline directions like "Say cheerfully: …" are read aloud; style goes in `speech_metadata.style` instead.
- **Unary output is WAV by default** (RIFF header). Headerless `AUDIO_L16` is optional.
- Prebuilt voices, an extended voice library (`GET /v1beta/voices`) and custom voices. Over 130 languages, detected automatically.
- No structured outputs, no thinking and no Live API. Batch is supported, which could be used for bulk question pre-generation.
- The page states no sample rate or pricing; record both from the spike.

## LLM adapter: `gemini-3.8-flash`

`src/adapters/llm/gemini-llm.adapter.ts` implements `LlmAdapter.json()`.

- **Request mapping:** `systemInstruction`, `contents` from messages (`assistant` → `model`), `responseMimeType: 'application/json'`, `responseJsonSchema`, `temperature` and `maxOutputTokens`. Never set `responseSchema` together with `responseJsonSchema`.
- **Thinking level per prompt role**, stored on the prompt version next to temperature (a new column in the data migration):

  | Role | Thinking | Why |
  | --- | --- | --- |
  | evaluator | `low` | It's on the 8 s written-feedback budget (FR-FB-01) |
  | summariser | `medium` | Synchronous in `/complete` |
  | drafter | `medium` | An admin waits up to 15 s, then it goes async |
  | admin test evaluation | `low` | Same as the evaluator |

- **Error handling.** Port `xenveo-ats-backend/src/ai/gemini.service.ts`:
  - `ensureModel` once per model;
  - check `finishReason` before reading `.text`;
  - non-retryable: `MAX_TOKENS`, `SAFETY`, 400/403 and a 429 per-day quota;
  - retryable: timeout, 429 per-minute and 5xx.

  Throw `LlmUnavailableError`, so the evaluator keeps its single retry and `ai_unavailable` behaviour (FR-INT-09: offer retry or typed mode).
- **Prompt safety is unchanged.** The transcript stays inside `<candidate_answer>` delimiters, and the hiring-verdict blocklist still runs.
- **Schemas:** unit-test that the evaluator, summariser and drafter `z.toJSONSchema` output is accepted. Strip unsupported keywords in the adapter, not in the shared schemas.

**Model config (NFR-12).**
- Prompt rows keep `model`. The seed defaults in `src/modules/ai/prompts/defaults.ts` change from `claude-opus-5-5` to `gemini-3.8-flash`.
- A data migration inserts a new active version per role, so history and session snapshots stay intact.
- AI config `PUT` rejects a model the provider doesn't serve, using `ensureModel` and returning 400.

## STT adapter: `gemini-3.8-flash` (uploaded answers)

`src/adapters/stt/gemini-stt.adapter.ts` implements `SttAdapter.transcribe()`.
- **Request:** the uploaded audio (webm, ogg, mp4, m4a or mpeg, at most 25 MiB and 300 s) as `inlineData`; check the current inline request size limit. Use `temperature: 0`, thinking `low`, and a structured output `{ text, words: [{ w, start, end }] }`.
- **The contract requires word timestamps.** The existing metrics (`scoring/metrics.ts`) use them for wpm, pause count and longest pause. Flash is a general multimodal model, not an aligned speech recogniser, so its timestamps may be approximate. The P0 spike decides (D2):
  - **Outcome A (accurate enough):** keep all metrics as designed.
  - **Outcome B:** keep the transcript only. wpm = words ÷ duration and fillers come from the transcript. Pause count and longest pause become `null`, and the UIs hide null metrics.
- **Duration** comes from the container header via a small parser, not from the timestamps. The client-sent `durationSec` is only cross-checked. This also fixes the acceptance finding where the fake STT's duration overwrote the real one.

## TTS adapter: `gemini-3.8-flash-tts` (interviewer voice)

`src/adapters/tts/gemini-tts.adapter.ts` implements `TtsAdapter.speak(text, voice)`:
- One `generateContent` call per clip, with the text as the only part, `responseModalities: [AUDIO]`, and the prebuilt voice from `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName` (check the exact field names against the TTS guide and the installed SDK).
- Keep `speech_metadata.style` short or empty; the voice choice carries the tone.
- The response is a WAV file. Store the bytes as they are, with `mimeType: 'audio/wav'` and no conversion.
- `durationS` is read from the WAV header (data size ÷ byte rate).
- Error mapping follows the shared Gemini client (retryable versus not). Failures throw `TtsUnavailableError`, and the UIs already fall back to text, or browser speech for cards.

This plugs into the existing places that call `TtsAdapter`:
- question audio pre-generation on role approval (`tts-pregen`), so a question starts within 2 s from cache (NFR-01);
- feedback audio after evaluation (`feedback.audio_ready`);
- card audio;
- admin voice samples.

All of them cache by hash in storage.

**Changes needed:**
- Generalise the mp3 assumptions to the extension returned by the adapter: `tts-cache.service.ts` (`tts/<hash>.mp3`), the storage key comment, and the `attempt-pipeline.service.ts` mime map.
- Voice labels in `WorkspaceSettings.voice` map to prebuilt voice names through one table.
- WAV is larger than mp3, about 1.4 MB for 30 s. That's acceptable for R1.

## Configuration

```
LLM_PROVIDER=gemini | anthropic | fake
STT_PROVIDER=gemini | deepgram | fake
TTS_PROVIDER=gemini | elevenlabs | fake
GEMINI_API_KEY=
GEMINI_STT_MODEL=gemini-3.8-flash
GEMINI_TTS_MODEL=gemini-3.8-flash-tts
GEMINI_TIMEOUT_MS=30000
```

Boot fails when a provider is `gemini` and `GEMINI_API_KEY` is missing. LLM model ids stay in the DB, so a Super admin can change them in Settings → AI. The STT and TTS models are env, because they aren't prompt roles.

## Costs and limits

- **Session budget (NFR-10, USD 0.50).** Per session there are about 10 evaluator calls, 10 transcriptions (Flash audio input), 10 feedback clips (`gemini-3.8-flash-tts`), 1 summariser call, and question audio that's amortised because it's cached per question. Measure it in the P0 spike from `usageMetadata` and record it here.
- **Rate limits.** Set `attempt` worker concurrency so 100 concurrent sessions (NFR-02) stay under the key's RPM, and check the TTS model's RPM for voicing bursts on role approval; Batch can absorb a large approval. Request increases before the load test.
- A 429 per-day quota is non-retryable and surfaces as `ai_unavailable`.

## P0 spike (before P2)

Write throwaway scripts in the scratchpad, not the repo, and run them with the real key:
1. **Transcription:** about 10 real recordings of 20–120 s each, with known pauses and fillers, through `gemini-3.8-flash`. Measure word error rate against a manual transcript, check that timestamps are monotonic and inside the audio, and spot-check ±0.3 s on word boundaries. Decide Outcome A or B.
2. **Evaluator:** the existing evaluator prompt on `gemini-3.8-flash`, thinking `low`, for 5 answers. Check schema acceptance, latency (p90 < 4 s target) and cost.
3. **Voicing:** `gemini-3.8-flash-tts` reading 10 question, feedback and card texts. Check the voices for the workspace voice labels, the latency for a 30 s clip, the WAV sample rate and size, and the cost.
4. **Quotas:** RPM for each of the two models on the key.

Record the results here and in the ledger.

## P0 results (2026-10-16)

**Method.** The scripts and data are in the session scratchpad, not the repo.
- **Corpus:** 8 synthetic answers of 14–22 s, spoken by 7 macOS voices: Rishi, Veena and Lekha (Indian English), Samantha, Daniel, Karen and Moira. Segments were trimmed and joined with silences of exact known length, giving exact ground truth: text, fillers, and 15 pauses over 1 s.
- **Long answers:** two joined from that corpus, 66 s (11 pauses) and 146 s (22 pauses).
- **Format:** encoded as AAC/m4a (`audio/mp4`).
- **Evaluator input:** the backend's own evaluator template, user message and Zod schema (`dump_eval.ts` imports them), on two seeded questions.
- **Prices:** paid-tier list prices valid to 2026-12-31. They double from 2027-01-01.

**Transcription (`gemini-3.8-flash`).** Accurate, but per-word timestamps don't scale.

| Variant | Accuracy | Pauses > 1 s | Latency | Verdict |
| --- | --- | --- | --- | --- |
| Per-word `{w,start,end}` (current contract) | mean WER 0.9%, fillers 12/12, timestamps monotonic and in range | 13/15 found, 0 false (short clips) | **7–11 s for a 17 s clip**; about 1,000 output tokens for 45 words, so a 2-min answer would take about 60 s | ✗ too slow |
| **Compact `{text, pauses[{start,end}]}`** | WER 0–3.2%, fillers 28/28 (long ones included) | 14/15 on short clips, but **4/11 at 66 s and 5/22 with 10 false at 146 s** | 2.8–5.7 s short; **4.3 s at 66 s, 7.8 s at 146 s** | ✓ transcript; ✗ pauses on real-length answers |

→ Use the compact transcript. **Gemini can't supply reliable pause metrics** for 1–2 min answers, so D2 needs a different source (see "Decisions raised").

**Evaluator (`gemini-3.8-flash`, thinking `low`, real prompt and schema).**
- 5/5 returned valid JSON with `finishReason=STOP` and all required keys.
- Scores were plausible: short synthetic answers rated 1–3. `spoken_summary` was 35–58 words, under the 80-word rule.
- Latency **6.2–7.7 s**, about 730 output tokens. Thinking tokens were mostly 0, but `low` occasionally spent about 300.

**Feedback latency (FR-FB-01 target: p90 ≤ 8 s).** Transcription (≈ 4–8 s for 1–2 min answers) plus evaluation (≈ 6–8 s) comes to **about 11–15 s**, so the target is **not met**. See "Decisions raised".

**Voice (`gemini-3.8-flash-tts`).**
- 10/10 clips are **WAV, 24 kHz, mono, 16-bit**, about 47 KB/s; a 30 s clip is about 1.4 MB.
- Verbatim: re-transcribing the output matched the input text (9/10 exact, 1 at 8% WER from a name or number rendering).
- Latency 2.6–5.8 s per clip. That's fine, because questions are pre-generated and feedback audio follows the written feedback as its own event.
- Indian English voices exist in the voice library, e.g. `en-in-podcaster-7` (male, crisp interviewer) and `en-in-tutor-11` (female mentor), alongside standard voices like `aoede` and `charon`.

**Cost per session**, at 2026 prices:

| Item | Cost |
| --- | --- |
| 10 transcriptions (about $0.002–0.006 each, compact) | about $0.04 |
| 10 evaluations (about $0.0033 each) | about $0.033 |
| 10 feedback clips (about $0.003 each) | about $0.03 |
| Summariser | about $0.005 |
| Question audio | amortised |
| **Total** | **≈ $0.11/session**, or about $0.22 from 2027 |

That's well under the USD 0.50 target (NFR-10).

**Not measured.**
- **Rate limits and the key's tier:** the API doesn't expose them. Check them in Google AI Studio.
- **Free-tier warning:** the free tier lets Google use the content to improve its products, so production must use a paid-tier key, because candidate answers are personal data.
- **Not covered by the corpus:** real human speech with noise and real accents, and Chrome's `audio/webm` (opus) uploads; there's no encoder on this machine. Re-check both in P3 with real recordings.

### Decisions raised by P0 (decided by the user, 2026-10-16: 1a and 2a)

**Decided:**
- **Pauses** are measured in the browser while recording (1a).
- **The evaluator is split** into a fast written-feedback call and a background call for the spoken summary and review details (2a).
- **Transcription** uses the compact `{text, pauses}` schema. The model's pauses are ignored in favour of the browser's measurements.

These change the P2 tasks below (G-STT, G-EVAL, candidate pause meter).


1. **Pause metrics (D2).** Gemini's timings are unreliable on real-length answers. Options:
   - **(a) Recommended: measure in the browser while recording.** The candidate room already holds the mic stream. A small Web Audio level detector computes pause count, longest pause and speaking time, which are sent with the upload next to `durationSec`.
     - It's accurate, needs no new dependency, and adds no server cost.
     - The trade-off is that the client reports them. In a practice tool that only affects the candidate's own coaching, which is acceptable.
     - The server still computes wpm and fillers from the transcript.
   - **(b) Server-side decode** with an audio decoder (ffmpeg, a new system dependency in the image).
   - **(c) Drop pauses** and keep pace and fillers only.
2. **Feedback latency (FR-FB-01).** Expected 11–15 s against 8 s. Options:
   - **(a) Recommended: split the evaluator.** A first call returns only what the feedback panel needs (scores, worked, improve, opener, improvement points), at about 300–400 output tokens, so about 3–4 s. A second call, in parallel or right after, returns `spoken_summary`, highlights and evidence for the spoken feedback and the admin review. That brings written feedback to about 7–11 s.
   - **(b)** Accept about 12–15 s for R1. The UI already shows "transcribing" and "evaluating" states.
   - **(c)** Measure the real p90 in P3 before deciding.

- **Unit tests** with a mocked `GoogleGenAI`: request mapping, thinking levels, errors and cost; STT schema parsing for both outcomes; the TTS request, WAV pass-through and duration, and the voice table.
- **e2e** stays on fakes.
- **Opt-in smoke test** `npm run smoke:ai` (needs `GEMINI_API_KEY`, never in CI): one evaluation, one transcription and one voicing.

## Ownership (Phase 2)

| Task | Files | Depends on |
| --- | --- | --- |
| **G-LLM** | `src/adapters/gemini/**` (shared client, errors, `ensureModel`), `src/adapters/llm/gemini-llm.adapter{,.spec}.ts`, provider wiring, `env.ts` Gemini keys, `.env.example`, `package.json` (`@google/genai`), prompt defaults and data migration (new versions + thinking level), the AI-config model check | P0 |
| **G-STT** | `src/adapters/stt/gemini-stt.adapter{,.spec}.ts`, the container-duration parser; for Outcome B also `scoring/metrics.ts`, `scoring/delivery.ts` and their specs | G-LLM, spike |
| **G-TTS** | `src/adapters/tts/gemini-tts.adapter{,.spec}.ts`, voice table, WAV duration helper, `tts-cache.service.ts`, the voice-sample route, the mime map | G-LLM |
| **G-EVAL** | Split the evaluator, in `src/modules/ai/evaluator.service.ts`, `schemas.ts`, the prompt defaults (two evaluator prompt roles, or one role with two templates; decide in the brief), the pipeline publishing `attempt.evaluated` after call 1, and the spoken summary/TTS and highlights after call 2 | G-LLM |
| Candidate UI | **Pause meter:** a Web Audio level detector during recording that sends `pauseCount`, `longestPauseSec` and `speakingSec` with the upload. Plus WAV playback check | G-STT (upload fields) |
| Backend (with G-STT) | Accept the optional pause fields in the attempt multipart (Zod-validated, clamped to the duration), store them on the attempt, and compute wpm from transcript words ÷ speaking time | — |

G-LLM owns the shared files: `env.ts`, `package.json` and the wiring. G-STT and G-TTS run in parallel after it, and hand their env and wiring additions to the Coordinator.
