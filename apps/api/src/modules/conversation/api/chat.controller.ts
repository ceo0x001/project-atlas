import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import type { SessionId } from '@atlas/shared-kernel';
import { type AuthenticatedRequest, DeviceAuthGuard } from '@modules/identity';
import { ZodValidationPipe } from '@shared/validation/zod-validation.pipe';
import { ConversationService } from '../application/conversation.service';
import { type AskRequest, type AskResponse, askSchema } from './chat.dto';

/**
 * Text chat with Atlas.
 *
 * The user is the authenticated device's owner — never a body field. Voice reuses
 * this whole path in M3, with speech-to-text in front and text-to-speech behind;
 * the agent loop and the grounding gate do not change.
 */
@Controller('v1/chat')
@UseGuards(DeviceAuthGuard)
export class ChatController {
  constructor(private readonly conversation: ConversationService) {}

  @Post()
  @HttpCode(200)
  async ask(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(askSchema)) body: AskRequest,
  ): Promise<AskResponse> {
    const answer = await this.conversation.ask({
      userId: request.principal.userId,
      question: body.question,
      ...(body.sessionId ? { sessionId: body.sessionId as SessionId } : {}),
    });

    return {
      sessionId: answer.sessionId,
      turnId: answer.turnId,
      answer: answer.text,
      canvas: answer.canvas,
      grounding: answer.groundingStatus,
      latencyMs: answer.latencyMs,
      ...(answer.degradedReason ? { notice: answer.degradedReason } : {}),
    };
  }
}
