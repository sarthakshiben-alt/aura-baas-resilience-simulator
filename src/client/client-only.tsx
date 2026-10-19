"use client";

import { useSyncExternalStore, type ReactNode } from "react";

const noopSubscribe = () => () => {};

/** Renders `fallback` during SSR and hydration, `children` once on the client. */
export function ClientOnly({ children, fallback = null }: { children: ReactNode; fallback?: ReactNode }) {
  const isClient = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return <>{isClient ? children : fallback}</>;
}

export function PageLoading() {
  return <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted">Starting the deterministic simulator…</div>;
}
