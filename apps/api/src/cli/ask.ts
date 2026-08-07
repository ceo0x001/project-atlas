// Ask Atlas a question from the terminal.
//
//   node dist/cli/ask.js --user <userId> "how much did I spend this month?"
//
// Exists because the fastest way to judge whether the assistant is any good is to
// talk to it. It runs the real agent loop against the real ledger and the real
// model — no HTTP, no device token — so it is a development tool, not a product
// surface.
import 'dotenv/config';

import { NestFactory } from '@nestjs/core';
import type { SessionId, UserId } from '@atlas/shared-kernel';
import { AppModule } from '../app.module';
import { ConversationService } from '../modules/conversation/application/conversation.service';

function usage(): never {
  process.stderr.write(
    'usage: node dist/cli/ask.js --user <userId> [--session <sessionId>] "<question>"\n',
  );
  process.exit(2);
}

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;

  const value = args[index + 1];
  args.splice(index, 2);

  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const userId = takeFlag(args, '--user');
  const sessionId = takeFlag(args, '--session');
  const question = args.join(' ').trim();

  if (!userId || question === '') usage();

  const app = await NestFactory.createApplicationContext(AppModule, {
    // The conversation service logs grounding outcomes at warn/error; those are
    // exactly what you want to see while judging answers.
    logger: ['warn', 'error'],
  });

  try {
    const answer = await app.get(ConversationService).ask({
      userId: userId as UserId,
      question,
      ...(sessionId ? { sessionId: sessionId as SessionId } : {}),
    });

    const lines = [
      '',
      answer.text ?? `(answer suppressed) ${answer.degradedReason ?? ''}`,
      '',
      `  grounding ${answer.groundingStatus}   latency ${answer.latencyMs}ms   session ${answer.sessionId}`,
    ];

    if (answer.canvas) {
      lines.push(`  canvas    ${answer.canvas.kind}: ${JSON.stringify(answer.canvas.payload)}`);
    }

    process.stdout.write(`${lines.join('\n')}\n\n`);
  } finally {
    await app.close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
