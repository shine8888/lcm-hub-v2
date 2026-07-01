import { Module } from '@nestjs/common';

import { AnthropicBackend } from './backends/anthropic.backend';
import { OpenAIBackend } from './backends/openai.backend';
import { LLMGatewayRouter } from './router';
import { GatewayController } from './gateway.controller';

@Module({
  controllers: [GatewayController],
  providers: [AnthropicBackend, OpenAIBackend, LLMGatewayRouter],
})
export class AppModule {}
