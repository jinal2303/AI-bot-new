import { Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import {
  TRADE_CREATED_EVENT,
  TRADE_STATUS_CHANGED_EVENT,
  TradeCreatedPayload,
  TradeStatusChangedPayload,
} from '../trades/trade-events';

const allowedOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:3000')
  .split(',')
  .map((origin) => origin.trim());

/**
 * Pushes live trade lifecycle events to every connected dashboard the
 * instant they happen — a fresh signal the moment the 60s strategy tick
 * persists one, and a position-status change (TARGET_HIT / STOPLOSS_HIT)
 * the instant the 10s position monitor detects it. No polling delay for
 * either the entry-alert or the exit-popup engine on the frontend.
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
      `Broadcasting status change — ${payload.signal.id} → ${payload.signal.currentStatus}`,
    );
    this.server.emit('signal-status-changed', payload);
  }
}
