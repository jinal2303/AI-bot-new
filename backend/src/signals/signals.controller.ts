import { Controller, Get, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { SignalsService } from './signals.service';
import { SignalData } from './signals.types';

@Controller('signals')
export class SignalsController {
  private readonly logger = new Logger(SignalsController.name);

  constructor(private readonly signalsService: SignalsService) {}

  /**
   * GET /api/signals/latest
   * Returns the most recently computed signal data matrix. If nothing has
   * been computed yet, this triggers a synchronous first-time refresh.
   */
  @Get('latest')
  async getLatestSignal(): Promise<SignalData> {
    try {
      return await this.signalsService.getLatestSignal();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Failed to serve latest signal: ${message}`);
      throw new HttpException(
        { message: 'Unable to compute the latest signal right now.', detail: message },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
