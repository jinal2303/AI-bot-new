import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-primary text-primary-foreground',
        secondary: 'border-transparent bg-secondary text-secondary-foreground',
        outline: 'border-border text-foreground',
        bullish: 'border-transparent bg-bullish text-bullish-foreground',
        bearish: 'border-transparent bg-bearish text-bearish-foreground',
        // Trade-status badges (Screen 1's live table) — deliberately loud,
        // saturated colors distinct from the theme's bullish/bearish tones
        // so a status reads at a glance across a full day's row of trades.
        active: 'animate-pulse border-transparent bg-amber-400 text-amber-950',
        target: 'border-transparent bg-emerald-500 text-emerald-950',
        stoploss: 'border-transparent bg-red-800 text-red-50',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
