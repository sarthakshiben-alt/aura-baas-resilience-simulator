"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { SimController } from "./controller";

const Ctx = createContext<SimController | null>(null);

/**
 * The simulation lives in the browser (and is restored from sessionStorage).
 * Store-dependent UI is wrapped in <ClientOnly> so SSR/hydration always see
 * the same fallback markup.
 */
export function SimProvider({ children }: { children: ReactNode }) {
  const [controller] = useState(() => new SimController());
  useEffect(() => {
    void controller.init();
    return () => controller.pause();
  }, [controller]);
  return <Ctx.Provider value={controller}>{children}</Ctx.Provider>;
}

/** Subscribes the component to simulation updates and returns the controller. */
export function useSim(): SimController {
  const c = useContext(Ctx);
  if (!c) throw new Error("useSim must be used inside <SimProvider>");
  useSyncExternalStore(c.subscribe, c.getVersion, () => 0);
  return c;
}
