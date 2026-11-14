type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void | Promise<unknown>;
    };
  }
}

/** Never pass free-form content, identifiers, filenames, or personal data here. */
export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;
  try {
    const result = window.umami?.track(name, data);
    // Trackers may reject asynchronously, as well as throw synchronously.
    if (result) void Promise.resolve(result).catch(() => {});
  } catch {
    // Analytics is optional and must never interrupt the user's action.
  }
}
