import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthUser } from '../../common/auth/auth.types.js';
import {
  ClientIp,
  CurrentUser,
} from '../../common/auth/current-user.decorator.js';
import { Roles } from '../../common/auth/roles.decorator.js';
import { notFound } from '../../common/errors/app-error.js';
import {
  QUEUE_SERVICE,
  type QueueService,
} from '../../common/queue/queue.types.js';
import { ZodPipe } from '../../common/validation/zod.pipe.js';
import { AiQuotaService } from './ai-quota.service.js';
import {
  DRAFT_WAIT_MS,
  type AiDraftJob,
  type AiDraftResult,
} from './ai-draft.processor.js';
import { CardsService } from './cards.service.js';
import {
  draftCountSchema,
  flashCardInputSchema,
  questionInputSchema,
  reorderSchema,
  roleInputSchema,
  rolePatchSchema,
  roleStatusQuerySchema,
  testAnswerSchema,
  uuidParam,
  type FlashCardInput,
  type QuestionInput,
  type ReorderInput,
  type RoleInput,
  type RolePatch,
  type RoleStatusQuery,
  type TestAnswerInput,
} from './content.schemas.js';
import type {
  AdminFlashCard,
  AdminJobRole,
  AdminQuestion,
  TestEvaluation,
} from './content.serializers.js';
import { QuestionsService } from './questions.service.js';
import {
  RolesService,
  type Actor,
  type ApproveRequirements,
} from './roles.service.js';

/** Path ids are uuids; anything else can't exist. */
class UuidParamPipe {
  transform(value: unknown): string {
    const parsed = uuidParam.safeParse(value);
    if (!parsed.success) throw notFound();
    return parsed.data;
  }
}
const uuid = new UuidParamPipe();

const cardsDraftSchema = draftCountSchema(3);
const questionsDraftSchema = draftCountSchema(2);

/** Admin roles, flash cards and questions (spec "Admin API → Roles and content"; admin UI services/roles.ts). */
@Roles('admin', 'super_admin')
@Controller('admin')
export class AdminContentController {
  constructor(
    private readonly roles: RolesService,
    private readonly cards: CardsService,
    private readonly questions: QuestionsService,
    private readonly quota: AiQuotaService,
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
  ) {}

  // ---- Roles --------------------------------------------------------------

  @Get('roles')
  listRoles(
    @Query(new ZodPipe(roleStatusQuerySchema)) query: RoleStatusQuery,
  ): Promise<AdminJobRole[]> {
    return this.roles.list(query.status);
  }

  @Post('roles')
  createRole(
    @Body(new ZodPipe(roleInputSchema)) body: RoleInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminJobRole> {
    return this.roles.create(body, actor(user, ip));
  }

  @Get('roles/:id')
  getRole(@Param('id', uuid) id: string): Promise<AdminJobRole> {
    return this.roles.get(id);
  }

  @Patch('roles/:id')
  updateRole(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(rolePatchSchema)) body: RolePatch,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminJobRole> {
    return this.roles.update(id, body, actor(user, ip));
  }

  @Get('roles/:id/approve-requirements')
  approveRequirements(
    @Param('id', uuid) id: string,
  ): Promise<ApproveRequirements> {
    return this.roles.requirements(id);
  }

  @Post('roles/:id/approve')
  @HttpCode(200)
  approveRole(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<{ role: AdminJobRole; notified: number }> {
    return this.roles.approve(id, actor(user, ip));
  }

  @Post('roles/:id/archive')
  @HttpCode(200)
  archiveRole(
    @Param('id', uuid) id: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminJobRole> {
    return this.roles.archive(id, actor(user, ip));
  }

  // ---- Flash cards --------------------------------------------------------

  @Get('roles/:id/cards')
  listCards(@Param('id', uuid) id: string): Promise<AdminFlashCard[]> {
    return this.cards.list(id);
  }

  @Post('roles/:id/cards')
  createCard(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(flashCardInputSchema)) body: FlashCardInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminFlashCard> {
    return this.cards.create(id, body, actor(user, ip));
  }

  @Put('roles/:id/cards/order')
  reorderCards(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(reorderSchema)) body: ReorderInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminFlashCard[]> {
    return this.cards.reorder(id, body.orderedIds, actor(user, ip));
  }

  @Post('roles/:id/cards/draft-ai')
  @HttpCode(200)
  draftCards(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(cardsDraftSchema)) body: { count: number },
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiDraftResult | { jobId: string }> {
    return this.draft('cards', id, body.count, user, ip, res);
  }

  @Put('cards/:cardId')
  updateCard(
    @Param('cardId', uuid) cardId: string,
    @Body(new ZodPipe(flashCardInputSchema)) body: FlashCardInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminFlashCard> {
    return this.cards.update(cardId, body, actor(user, ip));
  }

  @Post('cards/:cardId/approve')
  @HttpCode(200)
  approveCard(
    @Param('cardId', uuid) cardId: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminFlashCard> {
    return this.cards.approve(cardId, actor(user, ip));
  }

  @Delete('cards/:cardId')
  @HttpCode(204)
  discardCard(
    @Param('cardId', uuid) cardId: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.cards.discard(cardId, actor(user, ip));
  }

  // ---- Questions ----------------------------------------------------------

  @Get('roles/:id/questions')
  listQuestions(@Param('id', uuid) id: string): Promise<AdminQuestion[]> {
    return this.questions.list(id);
  }

  @Post('roles/:id/questions')
  createQuestion(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(questionInputSchema)) body: QuestionInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminQuestion> {
    return this.questions.create(id, body, actor(user, ip));
  }

  @Post('roles/:id/questions/draft-ai')
  @HttpCode(200)
  draftQuestions(
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(questionsDraftSchema)) body: { count: number },
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<AiDraftResult | { jobId: string }> {
    return this.draft('questions', id, body.count, user, ip, res);
  }

  @Put('questions/:qid')
  updateQuestion(
    @Param('qid', uuid) qid: string,
    @Body(new ZodPipe(questionInputSchema)) body: QuestionInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<AdminQuestion> {
    return this.questions.update(qid, body, actor(user, ip));
  }

  @Delete('questions/:qid')
  @HttpCode(204)
  deleteQuestion(
    @Param('qid', uuid) qid: string,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<void> {
    return this.questions.remove(qid, actor(user, ip));
  }

  @Post('questions/:qid/test')
  @HttpCode(200)
  testQuestion(
    @Param('qid', uuid) qid: string,
    @Body(new ZodPipe(testAnswerSchema)) body: TestAnswerInput,
    @CurrentUser() user: AuthUser,
    @ClientIp() ip: string,
  ): Promise<TestEvaluation> {
    return this.questions.test(qid, body.answer, actor(user, ip));
  }

  /** Waits up to 15 s for the `ai-draft` job: 200 with the new rows, else 202 `{jobId}` (plan §7). */
  private async draft(
    kind: AiDraftJob['kind'],
    roleId: string,
    count: number,
    user: AuthUser,
    ip: string,
    res: Response,
  ): Promise<AiDraftResult | { jobId: string }> {
    await this.roles.getEditableRow(roleId);
    await this.quota.consume(user.id);
    const outcome = await this.queue.addAndWait<AiDraftJob, AiDraftResult>(
      'ai-draft',
      { kind, roleId, count, adminId: user.id, ip },
      DRAFT_WAIT_MS,
    );
    if (outcome.done) return outcome.result;
    res.status(202);
    return { jobId: outcome.jobId };
  }
}

function actor(user: AuthUser, ip: string): Actor {
  return { id: user.id, ip };
}
