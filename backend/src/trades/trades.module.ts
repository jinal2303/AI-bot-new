import { Module } from '@nestjs/common';
import { TradesController } from './trades.controller';
import { TradesService } from './trades.service';
import { PositionMonitorService } from './position-monitor.service';
import { MarketDataModule } from '../market-data/market-data.module';

@Module({
  imports: [MarketDataModule],
  controllers: [TradesController],
  providers: [TradesService, PositionMonitorService],
  exports: [TradesService],
})
export class TradesModule {}
