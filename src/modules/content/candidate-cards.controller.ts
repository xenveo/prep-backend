import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Redirect,
} from '@nestjs/common';
import type { AuthUser } from '../../common/auth/auth.types.js';
import { CurrentUser } from '../../common/auth/current-user.decorator.js';
import { notFound } from '../../common/errors/app-error.js';
import { CandidateCardsService } from './candidate-cards.service.js';
import { positionParam } from './content.schemas.js';
import type { CandidateFlashCard } from './content.serializers.js';

/** The candidate UI's card id is the card's 1-based position. */
class PositionPipe {
  transform(value: unknown): number {
    const parsed = positionParam.safeParse(value);
    if (!parsed.success) throw notFound('Flash card not found');
    return parsed.data;
  }
}
const position = new PositionPipe();

/** Candidate flash cards (spec "Candidate API", FR-CARD-01..05). `roleId` is the role slug or uuid. */
@Controller('roles/:roleId/cards')
export class CandidateCardsController {
  constructor(private readonly cards: CandidateCardsService) {}

  @Get()
  list(
    @Param('roleId') roleId: string,
    @CurrentUser() user: AuthUser,
  ): Promise<{ cards: CandidateFlashCard[]; viewed: number[] }> {
    return this.cards.list(user.id, roleId);
  }

  @Post(':cardId/view')
  @HttpCode(204)
  view(
    @Param('roleId') roleId: string,
    @Param('cardId', position) cardId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<void> {
    return this.cards.view(user.id, roleId, cardId);
  }

  @Get(':cardId/audio')
  @Redirect()
  async audio(
    @Param('roleId') roleId: string,
    @Param('cardId', position) cardId: number,
    @CurrentUser() user: AuthUser,
  ): Promise<{ url: string; statusCode: number }> {
    return {
      url: await this.cards.audioUrl(user.id, roleId, cardId),
      statusCode: 302,
    };
  }
}
