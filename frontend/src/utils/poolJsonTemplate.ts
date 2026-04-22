// Canonical JSON schema example for SavedPool import. Rendered into the
// "Import JSON" modal as placeholder help text and served as the
// downloadable template file.

export const POOL_JSON_TEMPLATE = `{
  "name": "Team Liquid Red Side - Spring 2026",
  "champions": {
    "top": ["Aatrox", "K'Sante", "Renekton"],
    "jungle": ["Vi", "Wukong"],
    "mid": ["Azir", "Sylas"],
    "adc": ["Jinx", "Kai'Sa"],
    "support": ["Nautilus", "Rakan"]
  }
}
`;

export const POOL_JSON_TEMPLATE_FILENAME = "firstpick-pool-template.json";

export function downloadPoolJsonTemplate(): void {
    const blob = new Blob([POOL_JSON_TEMPLATE], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = POOL_JSON_TEMPLATE_FILENAME;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
}
