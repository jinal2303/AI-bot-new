import { Circle, ShieldAlert, Target } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { TradeStatus } from '@/lib/trade-signal';

const STATUS_CONFIG: Record<TradeStatus, { label: string; variant: 'active' | 'target' | 'stoploss'; icon: typeof Circle }> = {
  ACTIVE: { label: 'ACTIVE', variant: 'active', icon: Circle },
  TARGET_HIT: { label: 'TARGET HIT', variant: 'target', icon: Target },
  STOPLOSS_HIT: { label: 'STOPLOSS HIT', variant: 'stoploss', icon: ShieldAlert },
};

export function StatusBadge({ status }: { status: TradeStatus }) {
  const config = STATUS_CONFIG[status];
  const Icon = config.icon;

  return (
    <Badge variant={config.variant} className="gap-1">
      <Icon className="h-3 w-3" />
      {config.label}
    </Badge>
  );
}
