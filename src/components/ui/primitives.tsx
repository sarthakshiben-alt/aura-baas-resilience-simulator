"use client";

/** shadcn/ui-style primitives (copied-source pattern), adapted to the Aura tokens. */
import * as SwitchPrimitive from "@radix-ui/react-switch";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 cursor-pointer",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:brightness-110",
        secondary: "bg-surface-2 text-text border border-border hover:border-border-strong",
        ghost: "text-text-2 hover:bg-surface-2",
        danger: "bg-critical text-white hover:brightness-110",
        success: "bg-good-text text-white hover:brightness-110",
      },
      size: { sm: "h-8 px-2.5 text-xs", md: "h-9 px-3.5", lg: "h-11 px-5 text-base" },
    },
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export function Button({ className, variant, size, asChild, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-surface", className)} {...props} />;
}

export function CardHeader({ title, subtitle, right, className }: { title: ReactNode; subtitle?: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-start justify-between gap-3 border-b border-border px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-xs text-muted">{subtitle}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2">{right}</div> : null}
    </div>
  );
}

export function Badge({ className, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-text-2", className)} {...props} />;
}

export function Switch({ checked, onCheckedChange, label, id, disabled }: { checked: boolean; onCheckedChange: (v: boolean) => void; label: string; id?: string; disabled?: boolean }) {
  return (
    <SwitchPrimitive.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-border-strong bg-surface-2 transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block h-4 w-4 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </SwitchPrimitive.Root>
  );
}

export function Select({ className, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn("h-9 rounded-md border border-border bg-surface px-2 text-sm text-text", className)} {...props} />;
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("text-xs font-medium text-text-2", className)} {...props} />;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted">{children}</div>;
}

export function Kpi({ label, value, sub, status }: { label: string; value: ReactNode; sub?: ReactNode; status?: ReactNode }) {
  return (
    <Card className="flex flex-col p-3">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted">{label}</span>
      <div className="mt-1 text-xl font-semibold text-text">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-muted">{sub}</div> : null}
      {status ? <div className="mt-1.5">{status}</div> : null}
    </Card>
  );
}
