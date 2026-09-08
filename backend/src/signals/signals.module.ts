import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';
import { MarketDataService } from '../market-data/market-data.service';
import { IndicatorsService } from '../indicators/indicators.service';
import { ExpiryService } from '../expiry/expiry.service';

@Module({
  controllers: [SignalsController],
  providers: [SignalsService, MarketDataService, IndicatorsService, ExpiryService],
})
export class SignalsModule {}
