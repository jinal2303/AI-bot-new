import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { MarketDataModule } from '../market-data/market-data.module';
import { IndicatorsService } from '../indicators/indicators.service';
import { ExpiryService } from '../expiry/expiry.service';
import { TradesModule } from '../trades/trades.module';

@Module({
  imports: [MarketDataModule, TradesModule],
  controllers: [SignalsController],
  providers: [SignalsService, IndicatorsService, ExpiryService],
})
export class SignalsModule {}
