import { ArrowRightLeft, CalendarClock, LogOut } from 'lucide-react';
import { CarryRecommendation } from '@/lib/trade-signal';
import { cn } from '@/lib/utils';

const STYLES: Record<CarryRecommendation['action'], { icon: typeof LogOut; wrap: string; badge: string }> = {
  LEAN_CARRY: {
    icon: CalendarClock,
    wrap: 'border-sky-500/40 bg-sky-500/10 text-sky-300',
    badge: 'bg-sky-500/20 text-sky-300',
  },
  LEAN_SQUARE_OFF: {
    icon: LogOut,
    wrap: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
    badge: 'bg-amber-500/20 text-amber-300',
  },
  ALREADY_CARRIED: {
    icon: ArrowRightLeft,
    wrap: 'border-purple-500/40 bg-purple-500/10 text-purple-300',
    badge: 'bg-purple-500/20 text-purple-300',
  },
};

/**
 * A heuristic carry-vs-square-off suggestion for the active position, shown
 * only once it's actually relevant (inside the last hour before close, or
 * once the market has shut with the position still open). Purely advisory —
 * this app has no auto square-off and takes no action on its own.
 */
export function CarryAdvisory({ recommendation }: { recommendation: CarryRecommendation | null }) {
  if (recommendation === null) return null;

  const { icon: Icon, wrap, badge } = STYLES[recommendation.action];

  return (
    <div className={cn('mt-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm', wrap)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="flex items-center gap-2 font-medium">
          {recommendation.headline}
          <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide', badge)}>
            Suggestion
          </span>
        </p>
        <p className="mt-1 text-muted-foreground">{recommendation.reason}</p>
      </div>
    </div>
  );
}
