import { SignalData } from './types';

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

function expiryShortLabel(signal: SignalData): 'CURRENT' | 'NEXT' {
  return signal.expiry.cycle === 'CURRENT_WEEK' ? 'CURRENT' : 'NEXT';
}

/**
 * Fires a native desktop notification for a freshly detected BUY CALL /
 * BUY PUT signal. Deliberately does NOT set `silent: true`, so the OS
 * plays its standard default notification alert sound.
 */
export function notifyNewSignal(signal: SignalData): void {
  if (!isNotificationSupported() || Notification.permission !== 'granted') {
    return;
  }

  const optionLabel = signal.optionType; // 'CE' | 'PE'
  if (!optionLabel || !signal.tradeRules) {
    return; // Nothing actionable to notify about (NO_SIGNAL).
  }

  try {
    const { lotSize, maxRiskCashINR, targetCashINR } = signal.tradeRules;
    const body =
      `BUY NIFTY ${signal.atmStrike} ${optionLabel} (${expiryShortLabel(signal)} Expiry) | 1 Lot (${lotSize} units)\n` +
      `Max Risk: -₹${maxRiskCashINR.toLocaleString('en-IN')} | Target: +₹${targetCashINR.toLocaleString('en-IN')}`;

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
