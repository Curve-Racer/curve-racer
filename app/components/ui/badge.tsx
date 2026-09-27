import * as React from 'react';
import { cn } from '@/lib/cn';

export const Badge = React.forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement> & { tone?: 'default' | 'live' | 'armed' | 'profit' | 'loss' }
>(({ className, tone = 'default', ...props }, ref) => {
  const tones = {
    default: 'border-border text-muted-foreground',
    live: 'border-live/40 bg-live/10 text-live',
    armed: 'border-accent/40 bg-accent/10 text-accent',
    profit: 'border-profit/40 bg-profit/10 text-profit',
    loss: 'border-loss/40 bg-loss/10 text-loss',
  } as const;
  return (
    <span
      ref={ref}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5',
        'text-[11px] font-semibold uppercase tracking-wide',
        tones[tone],
        className
      )}
      {...props}
    />
  );
});
Badge.displayName = 'Badge';

/** Small pulsing dot used to signal a live round. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span className={cn('relative flex h-1.5 w-1.5', className)}>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-75" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-current" />
    </span>
  );
}
