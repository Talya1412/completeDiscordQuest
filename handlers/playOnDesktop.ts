/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { callWithRetry } from "../utils/retry";
import { QuestHandler } from "./types";

export const playOnDesktopHandler: QuestHandler = {
    supports(taskName: string) {
        return taskName === "PLAY_ON_DESKTOP";
    },

    handle({ quest, questName, secondsNeeded, secondsDone, applicationId, applicationName, pid, configVersion, isApp, RestAPI, FluxDispatcher, RunningGameStore, completingQuest, fakeGames, onQuestComplete }) {
        if (!isApp) {
            console.log("This no longer works in browser for non-video quests. Use the discord desktop app to complete the", questName, "quest!");
            return;
        }

        callWithRetry(() => RestAPI.get({ url: `/applications/public?application_ids=${applicationId}` }), { label: "applications/public" }).then(res => {
            const appData = (res as any).body[0];
            const exeName = appData.executables.find(x => x.os === "win32").name.replace(">", "");

            const fakeGame = {
                cmdLine: `C:\\Program Files\\${appData.name}\\${exeName}`,
                exeName,
                exePath: `c:/program files/${appData.name.toLowerCase()}/${exeName}`,
                hidden: false,
                isLauncher: false,
                id: applicationId,
                name: appData.name,
                pid: pid,
                pidPath: [pid],
                processName: appData.name,
                start: Date.now(),
            };
            const realGames = fakeGames.size === 0 ? RunningGameStore.getRunningGames() : [];
            fakeGames.set(quest.id, fakeGame);
            const fakeGames2 = Array.from(fakeGames.values());
            FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: realGames, added: [fakeGame], games: fakeGames2 });

            const playOnDesktop = event => {
                if (event.questId !== quest.id) return;
                const progress = configVersion === 1 ? event.userStatus.streamProgressSeconds : Math.floor(event.userStatus.progress.PLAY_ON_DESKTOP.value);
                console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

                if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                    console.log("Stopping completing quest:", questName);

                    fakeGames.delete(quest.id);
                    const games = RunningGameStore.getRunningGames();
                    const added = fakeGames.size === 0 ? games : [];
                    FluxDispatcher.dispatch({ type: "RUNNING_GAMES_CHANGE", removed: [fakeGame], added: added, games: games });
                    FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);

                    if (progress >= secondsNeeded) {
                        console.log("Quest completed!");
                        onQuestComplete();
                    } else {
                        completingQuest.set(quest.id, false);
                    }
                }
            };
            FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", playOnDesktop);

            console.log(`Spoofed your game to ${applicationName}. Wait for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
        }).catch(err => {
            console.error("Failed to fetch application data for quest", questName, err);
            completingQuest.set(quest.id, false);
        });
    }
};
