export const SpoofingSpeedMode = {
    BALANCED: "balanced",
    SPEEDRUN: "speedrun",
    STEALTH: "stealth",
} as const;

export type SpoofingSpeedMode = (typeof SpoofingSpeedMode)[keyof typeof SpoofingSpeedMode];

export interface SpoofingProfile {
    video: {
        maxFuture: number;
        speed: number;
        interval: number;
    };
    playActivity: {
        intervalMs: number;
    };
}
