import { QuestHandler } from "./types";

export const streamOnDesktopHandler: QuestHandler = {
    supports(taskName: string) {
        return taskName === "STREAM_ON_DESKTOP";
    },

    handle({ quest, questName, secondsNeeded, secondsDone, applicationId, applicationName, pid, configVersion, FluxDispatcher, completingQuest, fakeApplications, onQuestComplete }) {
        const fakeApp = {
            id: applicationId,
            name: `FakeApp ${applicationName} (CompleteDiscordQuest)`,
            pid: pid,
            sourceName: null,
        };
        fakeApplications.set(quest.id, fakeApp);

        const streamOnDesktop = event => {
            if (event.questId !== quest.id) return;
            const progress = configVersion === 1 ? event.userStatus.streamProgressSeconds : Math.floor(event.userStatus.progress.STREAM_ON_DESKTOP.value);
            console.log(`Quest progress ${questName}: ${progress}/${secondsNeeded}`);

            if (!completingQuest.get(quest.id) || progress >= secondsNeeded) {
                console.log("Stopping completing quest:", questName);

                fakeApplications.delete(quest.id);
                FluxDispatcher.unsubscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", streamOnDesktop);

                if (progress >= secondsNeeded) {
                    console.log("Quest completed!");
                    onQuestComplete();
                } else {
                    completingQuest.set(quest.id, false);
                }
            }
        };
        FluxDispatcher.subscribe("QUESTS_SEND_HEARTBEAT_SUCCESS", streamOnDesktop);

        console.log(`Spoofed your stream to ${applicationName}. Stream any window in vc for ${Math.ceil((secondsNeeded - secondsDone) / 60)} more minutes.`);
        console.log("Remember that you need at least 1 other person to be in the vc!");
    }
};
