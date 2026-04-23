import { Component, JSX, splitProps } from "solid-js";

type ChampionPortraitProps = Omit<
    JSX.ImgHTMLAttributes<HTMLImageElement>,
    "draggable" | "style"
> & {
    src: string;
    alt: string;
};

const DRAG_SAFE_STYLE = "-webkit-user-drag: none; user-select: none";

export const ChampionPortrait: Component<ChampionPortraitProps> = (props) => {
    const [, rest] = splitProps(props, []);
    return <img {...rest} draggable={false} style={DRAG_SAFE_STYLE} />;
};

export default ChampionPortrait;
