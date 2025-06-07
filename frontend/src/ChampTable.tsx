import { For } from "solid-js";
import { champions } from "./utils/constants";

type props = {
    inputValue: string;
};

function ChampTable(props: props) {
    return (
        <div class="grid grid-cols-5 overflow-y-scroll">
            <For
                each={champions.filter((value) => value.name.includes(props.inputValue))}
            >
                {(champ) => <img src={champ.img} />}
            </For>
        </div>
    );
}

export default ChampTable;
