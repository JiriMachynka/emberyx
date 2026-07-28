import { useEffect } from "react";
import { refreshPricing } from "@/lib/pricing";

/** Refresh the cached LiteLLM pricing catalog once on launch (quiet on
 *  failure, no-op if the cache is still fresh). */
export function usePricingRefresh() {
  useEffect(() => {
    void refreshPricing();
  }, []);
}
