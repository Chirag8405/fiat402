import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap", {
  variants: {
    variant: {
      default: "border-transparent bg-primary text-primary-foreground",
      muted: "border-transparent bg-muted text-muted-foreground",
      success: "border-transparent bg-success/15 text-success",
      warning: "border-transparent bg-warning/15 text-warning",
      danger: "border-transparent bg-danger/15 text-danger",
      outline: "border-border text-foreground",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Appends font-mono -- for badges whose text is a literal protocol/state token (state names, scheme/network) rather than human-phrased copy. Default false preserves every existing call site's sans rendering. */
  mono?: boolean;
}

export function Badge({ className, variant, mono, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), mono && "font-mono", className)} {...props} />;
}
