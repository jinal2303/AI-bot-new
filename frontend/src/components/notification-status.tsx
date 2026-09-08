'use client';

import { Bell, BellOff, BellRing } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { requestNotificationPermission } from '@/lib/notifications';

interface NotificationStatusProps {
  permission: NotificationPermission | null;
  onPermissionChange: (permission: NotificationPermission | null) => void;
}

export function NotificationStatus({ permission, onPermissionChange }: NotificationStatusProps) {
  if (permission === 'granted') {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <BellRing className="h-3 w-3 text-bullish" />
        Alerts On
      </Badge>
    );
  }

  if (permission === 'denied') {
    return (
      <Badge variant="outline" className="gap-1.5 text-muted-foreground">
        <BellOff className="h-3 w-3" />
        Alerts Blocked
      </Badge>
    );
  }

  return (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={async () => {
        const result = await requestNotificationPermission();
        onPermissionChange(result);
      }}
    >
      <Bell className="h-3.5 w-3.5" />
      Enable Alerts
    </Button>
  );
}
