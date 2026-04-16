import { Component, Show, createEffect } from "solid-js";
import { Title, Meta } from "@solidjs/meta";
import { useParams } from "@solidjs/router";
import { useNavigatorContext } from "../contexts/NavigatorContext";
import NavigatorSetup from "../components/navigator/NavigatorSetup";
import NavigatorDrafting from "../components/navigator/NavigatorDrafting";

const NavigatorSessionView: Component = () => {
    const params = useParams();
    const { navigatorContext, joinSession } = useNavigatorContext();

    createEffect(() => {
        const sessionId = params.sessionId;

        if (sessionId) {
            joinSession(sessionId);
        }
    });

    return (
        <div class="flex flex-1 flex-col overflow-hidden">
            <Title>Navigator Session - First Pick</Title>
            <Meta
                name="description"
                content="Configure and run live navigator draft analysis sessions."
            />
            <Show
                when={navigatorContext().session}
                fallback={
                    <div class="flex flex-1 items-center justify-center text-slate-400">
                        Loading session...
                    </div>
                }
            >
                <Show
                    when={navigatorContext().session?.status === "setup"}
                    fallback={<NavigatorDrafting />}
                >
                    <NavigatorSetup />
                </Show>
            </Show>
        </div>
    );
};

export default NavigatorSessionView;
