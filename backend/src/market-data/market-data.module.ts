import { Module } from '@nestjs/common';
import { MarketDataService } from './market-data.service';

/**
 * Shared by both SignalsModule (60s strategy tick, needs candle history)
 * and TradesModule's position monitor (10s exit tick, needs a fast quote).
 */
@Module({
  providers: [MarketDataService],
  exports: [MarketDataService],
})
export class MarketDataModule {}
