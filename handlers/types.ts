/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SpoofingProfile } from "../types/spoofing";

export interface QuestHandlerContext {
    quest: QuestValue;
    questName: string;
    taskName: string;
    secondsNeeded: number;
    secondsDone: number;
    applicationId: string;
    applicationName: string;
    configVersion: number;
    pid: number;
    isApp: boolean;
    completingQuest: Map<string, boolean>;
    fakeGames: Map<string, any>;
    fakeApplications: Map<string, any>;
    RestAPI: any;
    FluxDispatcher: any;
    RunningGameStore: any;
    ChannelStore: any;
    GuildChannelStore: any;
    getSpoofingProfile: () => SpoofingProfile;
    onQuestComplete: () => void;
}

export interface QuestHandler {
    supports(taskName: string): boolean;
    handle(context: QuestHandlerContext): void | Promise<void>;
}
