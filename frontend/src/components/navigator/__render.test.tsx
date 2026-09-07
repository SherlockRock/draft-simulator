// @vitest-environment jsdom
import { afterEach, expect, test } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";

afterEach(cleanup);

test("solid renders and reacts under jsdom", async () => {
    const [n, setN] = createSignal(0);
    const { container } = render(() => (
        <button type="button" onClick={() => setN((v) => v + 1)}>
            count {n()}
        </button>
    ));
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("count 0");
    if (button) fireEvent.click(button);
    expect(button?.textContent).toBe("count 1");
});
