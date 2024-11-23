import { For } from "solid-js";
import { champions } from "./constants";

type props = {
  inputValue: string;
};

function ChampTable({ inputValue }: props) {
  console.log(inputValue);
  return (
    <div class="grid grid-cols-5 overflow-y-scroll">
      <For each={champions.filter((value) => value.name.includes(inputValue))}>
        {(champ) => <img src={champ.img} />}
      </For>
    </div>
  );
}

export default ChampTable;
