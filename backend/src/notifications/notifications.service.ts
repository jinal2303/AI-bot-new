import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Trigger hook for outbound trade-lifecycle notifications — currently
 * Telegram, behind TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. Both are optional:
 * with either unset, every call still logs the message (so nothing is lost
 * server-side) but skips the network call entirely, so a fresh checkout
 * works with zero notification setup.
 *
 * Callers (PositionMonitorService) never await failures into their own
 * control flow — see `send()` — a Telegram outage must never stall or break
 * position monitoring.
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly botToken: string | undefined;
  private readonly chatId: string | undefined;

  constructor(private readonly configService: ConfigService) {
    this.botToken = this.configService.get<string>('TELEGRAM_BOT_TOKEN') || undefined;
    this.chatId = this.configService.get<string>('TELEGRAM_CHAT_ID') || undefined;

    if (!this.botToken || !this.chatId) {
      this.logger.warn(
        'TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — trade notifications will be logged only, not sent.',
      );
    }
  }

  /**
   * Fire-and-forget: always logs the message, and additionally posts it to
   * Telegram when configured. Never throws — a delivery failure is logged
   * and swallowed so it can't take down the 10s position-monitor tick that
   * triggered it.
   */
  async send(message: string): Promise<void> {
    this.logger.log(`[notify] ${message}`);

    if (!this.botToken || !this.chatId) {
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text: message, parse_mode: 'Markdown' }),
      });

      if (!response.ok) {
        const body = await response.text();
        this.logger.error(`Telegram notify failed (HTTP ${response.status}): ${body}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`Telegram notify threw: ${message}`);
    }
  }
}
