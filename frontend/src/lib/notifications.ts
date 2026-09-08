import { TradeSignal } from './trade-signal';
import { playLossChime, playWinChime } from './sound';

/** The desk's risk-protocol constants at the moment a signal was created — sourced from GET /api/signals/latest's tradeRules. */
export interface RiskConfig {
  lotSize: number;
  maxRiskCashINR: number;
  targetCashINR: number;
}

/** Returns true when the Notification API exists in this browser. */
export function isNotificationSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window;
}

/**
 * Requests native desktop notification permission from the user. Safe to
 * call repeatedly — the browser only prompts once per origin until the
 * user resets the permission.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission | null> {
  if (!isNotificationSupported()) {
    return null;
  }

  try {
    if (Notification.permission === 'granted' || Notification.permission === 'denied') {
      return Notification.permission;
    }
    return await Notification.requestPermission();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notifications] Failed to request permission:', error);
    return null;
  }
}

function optionLabel(direction: TradeSignal['direction']): 'CE' | 'PE' {
  return direction === 'CALL' ? 'CE' : 'PE';
}

function expiryShortLabel(expiryType: TradeSignal['expiryType']): 'CURRENT' | 'NEXT' {
  return expiryType === 'CURRENT_WEEK' ? 'CURRENT' : 'NEXT';
}

/**
 * Fires a native desktop notification the moment a fresh TradeSignal row
 * appears in GET /api/signals/today — i.e. a genuinely new entry, since
 * each row is created exactly once. Deliberately does NOT set
 * `silent: true`, so the OS plays its standard default alert sound.
 */
export function notifyNewEntry(signal: TradeSignal, risk: RiskConfig): void {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }

  try {
    const body =
      `BUY NIFTY ${signal.strikePrice} ${optionLabel(signal.direction)} (${expiryShortLabel(signal.expiryType)} Expiry) | 1 Lot (${risk.lotSize} units)\n` +
      `Max Risk: -₹${risk.maxRiskCashINR.toLocaleString('en-IN')} | Target: +₹${risk.targetCashINR.toLocaleString('en-IN')}`;

    const notification = new Notification('🚨 BOT SIGNAL DETECTED!', {
      body,
      tag: signal.id,
      requireInteraction: true,
      icon: '/favicon.ico',
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notifications] Failed to display notification:', error);
  }
}

/**
 * Fires the live exit popup for a position the backend just resolved as
 * TARGET_HIT or STOPLOSS_HIT, with a distinct win/loss audio chime
 * alongside the native OS notification sound.
 */
export function notifyExit(signal: TradeSignal, netCashINR: number): void {
  const isWin = signal.currentStatus === 'TARGET_HIT';

  // The audio chime plays regardless of Notification permission — it's an
  // in-tab cue, not dependent on OS-level permission grants.
  if (isWin) {
    playWinChime();
  } else {
    playLossChime();
  }

  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }

  try {
    const label = optionLabel(signal.direction);
    const title = isWin ? '🎯 TARGET ACHIEVED!' : '⚠️ STOP-LOSS TRIGGERED';
    const body = isWin
      ? `NIFTY ${signal.strikePrice} ${label} hit profit target! Net: +₹${netCashINR.toLocaleString('en-IN')} per lot.`
      : `NIFTY ${signal.strikePrice} ${label} exited at protection risk limit. Net: -₹${Math.abs(netCashINR).toLocaleString('en-IN')} per lot.`;

    const notification = new Notification(title, {
      body,
      tag: `${signal.id}-exit`,
      requireInteraction: true,
      icon: '/favicon.ico',
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[notifications] Failed to display exit notification:', error);
  }
}
