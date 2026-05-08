// Per-session dice roll. The decision is cached on the session so every event
// in a session is kept or dropped together — half-sampled sessions are useless
// for anything session-scoped (bounce rate, duration, replay).

export function rollSample(sampleRate: number): boolean {
    if (sampleRate >= 100) return true;
    if (sampleRate <= 0)   return false;
    return Math.random() * 100 < sampleRate;
}
