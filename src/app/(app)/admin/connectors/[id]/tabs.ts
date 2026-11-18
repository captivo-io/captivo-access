// Kept out of the client component so the server page can read it as a value.
export const TABS = ["overview", "resources", "logs", "activity", "settings"] as const;
export type Tab = (typeof TABS)[number];
