import { Component, For, Show, createSignal } from "solid-js";
import { Check, Copy } from "lucide-solid";

type SchemaField = {
    name: string;
    type: string;
    required: boolean;
    description: string;
};

const STANDALONE_DRAFT_FIELDS: SchemaField[] = [
    {
        name: "name",
        type: "string",
        required: true,
        description: "Draft display name"
    },
    {
        name: "picks",
        type: "string[20]",
        required: true,
        description: 'Champion IDs (e.g. "Aatrox") or "" for empty'
    },
    {
        name: "firstPick",
        type: '"blue" | "red"',
        required: false,
        description: 'Defaults to "blue"'
    },
    {
        name: "blueSideTeam",
        type: "1 | 2",
        required: false,
        description: "Defaults to 1"
    },
    {
        name: "positionX / positionY",
        type: "number",
        required: false,
        description: "Canvas placement position"
    }
];

const VERSUS_SERIES_FIELDS: SchemaField[] = [
    {
        name: "name",
        type: "string",
        required: false,
        description: "Series display name"
    },
    {
        name: "seriesLength",
        type: "1 | 3 | 5 | 7",
        required: true,
        description: "Best-of length"
    },
    {
        name: "draftType",
        type: '"standard" | "fearless" | "ironman"',
        required: false,
        description: 'Defaults to "standard"'
    },
    {
        name: "blueTeamName / redTeamName",
        type: "string",
        required: false,
        description: '"Team 1" / "Team 2"'
    },
    {
        name: "competitive",
        type: "boolean",
        required: false,
        description: "Defaults to false"
    },
    {
        name: "disabledChampions",
        type: "string[]",
        required: false,
        description: "Champion IDs to disable"
    }
];

const SERIES_DRAFT_FIELDS: SchemaField[] = [
    {
        name: "picks",
        type: "string[20]",
        required: true,
        description: "Same format as standalone"
    },
    {
        name: "name",
        type: "string",
        required: false,
        description: 'Defaults to "Game N"'
    },
    {
        name: "gameNumber",
        type: "number",
        required: false,
        description: "1-indexed position in series"
    },
    {
        name: "winner",
        type: '"blue" | "red"',
        required: false,
        description: "Game winner"
    },
    {
        name: "firstPick / blueSideTeam",
        type: "same as drafts",
        required: false,
        description: "Per-game overrides"
    }
];

const SECTIONS = [
    { label: "Standalone Drafts", fields: STANDALONE_DRAFT_FIELDS },
    { label: "Versus Series", fields: VERSUS_SERIES_FIELDS },
    { label: "Series \u2192 Drafts", fields: SERIES_DRAFT_FIELDS }
];

const STRUCTURE_EXAMPLE = `{
  "drafts": [{ ... }],
  "versusSeries": [{
    "seriesLength": 5,
    "drafts": [{ ... }]
  }]
}`;

const AGENT_EXAMPLE_JSON = `{
  "drafts": [
    {
      "name": "KT vs IG Match 3",
      "picks": [
        "Akali",
        "Ryze",
        "Urgot",
        "LeBlanc",
        "Camille",
        "Nocturne",
        "Thresh",
        "Aatrox",
        "Galio",
        "Syndra",
        "Irelia",
        "Gragas",
        "Azir",
        "KaiSa",
        "Rakan",
        "Fiora",
        "Xin Zhao",
        "Lissandra",
        "Xayah",
        "Alistar"
      ],
      "firstPick": "blue",
      "blueSideTeam": 1
    }
  ],
  "versusSeries": [
    {
      "name": "ROX Tigers vs SK Telecom T1 - Worlds 2016 Semifinal",
      "seriesLength": 5,
      "draftType": "standard",
      "blueTeamName": "ROX Tigers",
      "redTeamName": "SK Telecom T1",
      "competitive": true,
      "drafts": [
        {
          "name": "Game 1",
          "gameNumber": 1,
          "winner": "red",
          "picks": [
            "Ryze",
            "Ezreal",
            "Syndra",
            "",
            "",
            "Nidalee",
            "AurelionSol",
            "Jayce",
            "",
            "",
            "Caitlyn",
            "Elise",
            "Poppy",
            "Viktor",
            "Karma",
            "Zyra",
            "Olaf",
            "Trundle",
            "Ashe",
            "Orianna"
          ]
        },
        {
          "name": "Game 2",
          "gameNumber": 2,
          "winner": "red",
          "blueSideTeam": 2,
          "picks": [
            "AurelionSol",
            "Jayce",
            "Jhin",
            "",
            "",
            "Syndra",
            "Ryze",
            "Nidalee",
            "",
            "",
            "Olaf",
            "Zyra",
            "Ezreal",
            "Ekko",
            "Viktor",
            "Karma",
            "Ashe",
            "Rumble",
            "LeeSin",
            "MissFortune"
          ]
        },
        {
          "name": "Game 3",
          "gameNumber": 3,
          "winner": "blue",
          "picks": [
            "Syndra",
            "Ryze",
            "Karma",
            "",
            "",
            "AurelionSol",
            "Nidalee",
            "Jayce",
            "",
            "",
            "Ashe",
            "LeeSin",
            "Viktor",
            "Rumble",
            "MissFortune",
            "Caitlyn",
            "Olaf",
            "Orianna",
            "Zyra",
            "Ekko"
          ]
        },
        {
          "name": "Game 4",
          "gameNumber": 4,
          "winner": "blue",
          "blueSideTeam": 2,
          "picks": [
            "MissFortune",
            "Jayce",
            "AurelionSol",
            "",
            "",
            "Syndra",
            "Ryze",
            "Cassiopeia",
            "",
            "",
            "Nidalee",
            "Jhin",
            "Karma",
            "Gnar",
            "Zilean",
            "Ashe",
            "Zyra",
            "Viktor",
            "Olaf",
            "Rumble"
          ]
        },
        {
          "name": "Game 5",
          "gameNumber": 5,
          "winner": "red",
          "picks": [
            "Ryze",
            "Syndra",
            "Olaf",
            "",
            "",
            "MissFortune",
            "Nidalee",
            "AurelionSol",
            "",
            "",
            "Karma",
            "Zyra",
            "Jayce",
            "Jhin",
            "Elise",
            "Ashe",
            "LeeSin",
            "Orianna",
            "Nami",
            "Poppy"
          ]
        }
      ]
    }
  ]
}`;

export const SchemaReferencePanel: Component = () => {
    const [copied, setCopied] = createSignal(false);

    const copyExampleJson = async () => {
        await navigator.clipboard.writeText(AGENT_EXAMPLE_JSON);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1600);
    };

    return (
        <div class="custom-scrollbar min-h-0 flex-1 overflow-y-auto rounded-lg border border-darius-border bg-darius-bg">
            <div class="border-b border-darius-border p-3">
                <div class="flex items-start justify-between gap-2">
                    <div>
                        <div class="text-[0.625rem] font-bold uppercase tracking-wider text-darius-purple-bright">
                            JSON Shape
                        </div>
                        <p class="mt-1 text-[0.6875rem] leading-snug text-darius-text-secondary">
                            Champion IDs look like{" "}
                            <span class="font-mono text-darius-text-primary">Aatrox</span>
                            . Empty pick slots are{" "}
                            <span class="font-mono text-darius-text-primary">""</span>.
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={copyExampleJson}
                        class="shrink-0 cursor-pointer rounded-md bg-darius-purple p-1.5 text-darius-text-primary transition-colors hover:bg-darius-purple-bright"
                        aria-label="Copy example JSON"
                        title={copied() ? "Copied" : "Copy full example JSON"}
                    >
                        <Show when={!copied()} fallback={<Check size={14} />}>
                            <Copy size={14} />
                        </Show>
                    </button>
                </div>
                <pre class="mt-3 overflow-hidden rounded-md border border-darius-border bg-darius-card px-2.5 py-2 font-mono text-[0.625rem] leading-relaxed text-darius-text-secondary">
                    {STRUCTURE_EXAMPLE}
                </pre>
                <div class="mt-2 flex flex-wrap gap-1.5">
                    <span class="rounded bg-darius-purple/20 px-1.5 py-px text-[0.5625rem] font-semibold uppercase text-darius-purple-bright">
                        picks = 20 strings
                    </span>
                    <span class="rounded bg-darius-text-secondary/15 px-1.5 py-px text-[0.5625rem] font-semibold uppercase text-darius-text-secondary">
                        blank = ""
                    </span>
                </div>
            </div>

            <div class="flex flex-col gap-3 p-3">
                <For each={SECTIONS}>
                    {(section) => (
                        <section>
                            <div class="mb-2 flex items-center gap-2">
                                <div class="h-px flex-1 bg-darius-border" />
                                <h3 class="shrink-0 text-[0.625rem] font-bold uppercase tracking-wider text-darius-purple-bright">
                                    {section.label}
                                </h3>
                                <div class="h-px flex-1 bg-darius-border" />
                            </div>

                            <div class="flex flex-col gap-1.5">
                                <For each={section.fields}>
                                    {(field) => (
                                        <div class="rounded-md border border-darius-border/70 bg-darius-card/70 p-2">
                                            <div class="flex items-start justify-between gap-2">
                                                <div class="min-w-0 font-mono text-[0.6875rem] leading-tight text-darius-text-primary">
                                                    {field.name}
                                                </div>
                                                <span
                                                    class="shrink-0 rounded px-1.5 py-px text-[0.5625rem] font-semibold uppercase"
                                                    classList={{
                                                        "bg-darius-purple/20 text-darius-purple-bright":
                                                            field.required,
                                                        "bg-darius-text-secondary/15 text-darius-text-secondary":
                                                            !field.required
                                                    }}
                                                >
                                                    {field.required ? "req" : "opt"}
                                                </span>
                                            </div>
                                            <div class="mt-1 inline-flex max-w-full rounded bg-darius-bg px-1.5 py-px font-mono text-[0.625rem] leading-snug text-darius-purple-bright">
                                                <span class="break-words">
                                                    {field.type}
                                                </span>
                                            </div>
                                            <div class="mt-1 text-[0.6875rem] leading-snug text-darius-text-secondary">
                                                {field.description}
                                            </div>
                                        </div>
                                    )}
                                </For>
                            </div>
                        </section>
                    )}
                </For>
            </div>
        </div>
    );
};
