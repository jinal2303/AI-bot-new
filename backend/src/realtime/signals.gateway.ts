import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import {
  TARGET_MILESTONE_EVENT,
  TRADE_CREATED_EVENT,
  TRADE_STATUS_CHANGED_EVENT,
  TargetMilestonePayload,
  TradeCreatedPayload,
  TradeStatusChangedPayload,
} from '../trades/trade-events';

const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim());

/**
 * Pushes live trade lifecycle events to every connected dashboard the
 * instant they happen — a fresh signal the moment the 60s strategy tick
 * persists one, a target-progress milestone the moment the 10s position
 * monitor crosses one, and a position-status change (TARGET_HIT /
 * TRAIL_STOP_HIT / STOPLOSS_HIT / TIME_EXIT) the instant it resolves. No
 * polling delay for any of the frontend's live-alert engines.
 */
@WebSocketGateway({ cors: { origin: allowedOrigins } })
export class SignalsGateway {
  private readonly logger = new Logger(SignalsGateway.name);

  @WebSocketServer()
  server!: Server;

  /** Re-broadcasts a freshly-created signal over the 'signal-created' socket channel. */
  @OnEvent(TRADE_CREATED_EVENT)
  handleCreated(payload: TradeCreatedPayload): void {
    this.logger.log(`Broadcasting new signal — ${payload.signal.id} (${payload.signal.direction} ${payload.signal.strikePrice})`);
    this.server.emit('signal-created', payload);
  }

  /** Re-broadcasts the internal trade-status event over the 'signal-status-changed' socket channel. */
  @OnEvent(TRADE_STATUS_CHANGED_EVENT)
  handleStatusChanged(payload: TradeStatusChangedPayload): void {
    this.logger.log(
      `Broadcasting status change — ${payload.signal.id} → ${payload.signal.currentStatus}${payload.reason ? ` (${payload.reason})` : ''}`,
    );
    this.server.emit('signal-status-changed', payload);
  }

  /** Re-broadcasts a newly-crossed target-progress milestone over the 'signal-target-milestone' socket channel. */
  @OnEvent(TARGET_MILESTONE_EVENT)
  handleTargetMilestone(payload: TargetMilestonePayload): void {
    this.logger.log(`Broadcasting target milestone — ${payload.signal.id} reached ${payload.milestonePct}%`);
    this.server.emit('signal-target-milestone', payload);
  }
}
