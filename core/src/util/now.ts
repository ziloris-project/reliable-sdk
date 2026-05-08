// Single source of truth for "now". Keeping this in one place makes it trivial
// to stub during tests and means every module reports timestamps in the same
// format.

export const now = (): number => Date.now();

export const nowIso = (): string => new Date().toISOString();
