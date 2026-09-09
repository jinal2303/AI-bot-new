import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TradeSignal, TrailStage } from '@prisma/client';

/**
 * Trigger hook for outbound trade-lifecycle notifications — currently
 * Telegram, behind TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. Both are optional:
 * with either unset, every call still logs the message (so nothing is lost
 * server-side) but skips the network call entirely, so a fresh checkout
 * works with zero notification setup.
 *
 * Every trade-lifecycle event has its own typed `notify*` method here —
 * PositionMonitorService calls those instead of building Markdown strings
 * itself, so message formatting lives in exactly one place and every call
 * site stays readable. `send()` is the low-level primitive underneath, kept
 * public for the one-off case that doesn't warrant its own method.
 *
 * Callers never need to await failures into their own control flow — see
 * `send()` — a Telegram outage must never stall or break position monitoring.
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

  /** A position's dynamic stop-loss just ratcheted to a new stage (breakeven or profit-lock). */
  async notifyTrailingStopAdjusted(position: TradeSignal, trailStage: TrailStage, newStopLossSpot: number): Promise<void> {
    await this.send(
      `🔧 *Trailing stop adjusted*\n${position.direction} ${position.strikePrice} — stage → *${trailStage}*\nNew stop-loss: ${newStopLossSpot.toFixed(2)} (spot)`,
    );
  }

  /** Price just crossed a 10%-band milestone (30–90%) of the distance to the position's original target. */
  async notifyTargetMilestone(position: TradeSignal, milestonePct: number, progressPct: number, livePrice: number): Promise<void> {
    await this.send(
      `🎯 *Target Progress: ${milestonePct}%*\n${position.direction} ${position.strikePrice} @ spot ${livePrice}\n(${progressPct.toFixed(1)}% of the way to target)`,
    );
  }

  /** The one-time stale-position target reduction just fired (position open too long, in profit, target pulled in). */
  async notifyStaleTargetReduced(position: TradeSignal, holdMinutes: number, newTargetSpot: number): Promise<void> {
    await this.send(
      `⏱️ *Stale position — target reduced*\n${position.direction} ${position.strikePrice} — open ${holdMinutes.toFixed(0)}m, momentum stalled.\nTarget pulled in to ${newTargetSpot.toFixed(2)} (spot).`,
    );
  }

  /** The stale-position rule is about to force-exit at market (about to call notifyPositionClosed with TIME_EXIT). */
  async notifyStaleForceExit(position: TradeSignal, holdMinutes: number, livePrice: number): Promise<void> {
    await this.send(
      `🚪 *Time-decay exit*\n${position.direction} ${position.strikePrice} — open ${holdMinutes.toFixed(0)}m, gave back profit below the giveback floor.\nExiting at market (${livePrice}).`,
    );
  }

  /**
   * A position resolved to any terminal status. `reason` carries the
   * specific story when it wasn't a plain target/stop-loss boundary hit —
   * e.g. "mandatory EOD square-off", "Target Revised & Profit Locked at 62%".
   */
  async notifyPositionClosed(position: TradeSignal, status: string, livePrice: number, netCashINR: number, reason?: string): Promise<void> {
    const emoji = netCashINR >= 0 ? '✅' : '🛑';
    await this.send(
      `${emoji} *Position closed — ${status}*${reason ? `\n_${reason}_` : ''}\n${position.direction} ${position.strikePrice} @ spot ${livePrice}\nP&L: ₹${netCashINR}`,
    );
  }
}
