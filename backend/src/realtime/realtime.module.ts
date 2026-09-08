import { Module } from '@nestjs/common';
import { SignalsGateway } from './signals.gateway';

@Module({
  providers: [SignalsGateway],
})
export class RealtimeModule {}
