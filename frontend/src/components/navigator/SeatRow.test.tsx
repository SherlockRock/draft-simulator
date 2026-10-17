// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { ROLES } from "../../utils/championRoles";
import { SeatRow } from "./SeatRow";

// Frozen 2026-10-10 share table (plan-level decision 2); expected seatings from the Task 1 ground truth.
vi.mock("../../data/champions.json", async () => ({
    default: (await import("../../utils/__fixtures__/champions-2026-10-10-shares.json"))
        .default
}));

afterEach(cleanup);

type SeatSpec = { occupant: string | null; marker?: string; count?: string | null };
function expectSeats(
    root: ParentNode,
    spec: Partial<Record<(typeof ROLES)[number], SeatSpec>>
) {
    for (const role of ROLES) {
        const seat = root.querySelector(`[data-seat='${role}']`);
        expect(seat, role).not.toBeNull();
        const want = spec[role];
        if (!want) continue;
        if (want.occupant === null) {
            expect(seat?.getAttribute("data-open"), role).toBe("true");
            expect(seat?.hasAttribute("data-occupant"), role).toBe(false);
        } else {
            expect(seat?.getAttribute("data-occupant"), role).toBe(want.occupant);
            expect(seat?.hasAttribute("data-open"), role).toBe(false);
        }
        if (want.marker !== undefined)
            expect(seat?.getAttribute("data-marker"), role).toBe(want.marker);
        if (want.count !== undefined)
            expect(seat?.getAttribute("data-count"), role).toBe(want.count);
    }
}

describe("SeatRow — the ten stress states (design § 2 rule table)", () => {
    test("1 · solo flex on an empty board: Brand alone sits at support with the sky glow, four holes", () => {
        const { container } = render(() => (
            <SeatRow ids={["Brand"]} candidateIds={["Brand"]} side="blue" size="card" />
        ));
        expect(
            container.querySelector("[data-seat-row]")?.getAttribute("data-infeasible")
        ).toBe("false");
        expectSeats(container, {
            top: { occupant: null },
            jungle: { occupant: null },
            mid: { occupant: null },
            adc: { occupant: null },
            support: { occupant: "Brand", marker: "candidate" }
        });
        expect(container.querySelectorAll("[data-open='true']")).toHaveLength(4);
    });
    test("2 · two champions flexing into each other's roles: Diana mid, Ekko jungle, nothing extra", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Diana", "Ekko"]}
                candidateIds={["Ekko"]}
                side="blue"
                size="card"
            />
        ));
        expectSeats(container, {
            mid: { occupant: "Diana", marker: "none" },
            jungle: { occupant: "Ekko", marker: "candidate" }
        });
        expect(container.querySelectorAll("[data-marker='moved']")).toHaveLength(0);
    });
    test("3 · three-way flex: Poppy support, Tahm Kench top, Neeko mid — no moved marker", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Poppy", "TahmKench", "Neeko"]}
                candidateIds={["Neeko"]}
                side="red"
                size="card"
            />
        ));
        expectSeats(container, {
            support: { occupant: "Poppy", marker: "none" },
            top: { occupant: "TahmKench", marker: "none" },
            mid: { occupant: "Neeko", marker: "candidate" }
        });
    });
    test("4 · five red picks (the tour state + Pantheon): every seat taken, Pantheon support", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Sejuani", "Sylas", "Lissandra", "Tristana", "Pantheon"]}
                side="red"
                size="compact"
            />
        ));
        expect(container.querySelectorAll("[data-open='true']")).toHaveLength(0);
        expectSeats(container, {
            top: { occupant: "Sejuani" },
            jungle: { occupant: "Sylas" },
            mid: { occupant: "Lissandra" },
            adc: { occupant: "Tristana" },
            support: { occupant: "Pantheon" }
        });
    });
    test("5 · a pick that moves an earlier pick: Aphelios (sky) sends Ashe to support (amber)", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Ashe", "AurelionSol", "Aphelios"]}
                candidateIds={["Aphelios"]}
                side="red"
                size="card"
            />
        ));
        expectSeats(container, {
            support: { occupant: "Ashe", marker: "moved" },
            adc: { occupant: "Aphelios", marker: "candidate" },
            mid: { occupant: "AurelionSol", marker: "none" }
        });
        expect(
            container
                .querySelector("[data-seat='support'] [data-seat-ring]")
                ?.getAttribute("data-marker")
        ).toBe("moved");
    });
    test("6 · certain seats beside an uncertain one: Gragas top, Hecarim jungle, Akali mid, two holes", () => {
        const { container } = render(() => (
            <SeatRow ids={["Gragas", "Hecarim", "Akali"]} side="blue" size="compact" />
        ));
        expectSeats(container, {
            top: { occupant: "Gragas" },
            jungle: { occupant: "Hecarim" },
            mid: { occupant: "Akali" },
            adc: { occupant: null },
            support: { occupant: null }
        });
    });
    test("7 · infeasible side: Jinx + Aphelios both at adc, count 2, the row red with the reason", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Jinx", "Aphelios"]}
                side="red"
                size="compact"
                infeasibleText="✕ cannot fill five roles with Jinx, Aphelios"
            />
        ));
        expect(
            container.querySelector("[data-seat-row]")?.getAttribute("data-infeasible")
        ).toBe("true");
        expectSeats(container, {
            adc: { occupant: "Jinx", marker: "infeasible", count: "2" },
            top: { occupant: null },
            support: { occupant: null }
        });
        expect(
            container
                .querySelector("[data-seat='adc'] [data-seat-ring]")
                ?.getAttribute("data-marker")
        ).toBe("infeasible");
        expect(container.querySelector("[data-infeasible-text]")?.textContent).toBe(
            "✕ cannot fill five roles with Jinx, Aphelios"
        );
    });
    test("8 · pair pick: Xayah and Shen both sky beside Gragas, Hecarim, Akali", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Gragas", "Hecarim", "Akali", "Xayah", "Shen"]}
                candidateIds={["Xayah", "Shen"]}
                side="blue"
                size="card"
            />
        ));
        expectSeats(container, {
            adc: { occupant: "Xayah", marker: "candidate" },
            support: { occupant: "Shen", marker: "candidate" },
            top: { occupant: "Gragas", marker: "none" }
        });
    });
    test("9 · empty board, then one pick: five holes; Jinx alone at adc", () => {
        const empty = render(() => <SeatRow ids={[]} side="red" size="compact" />);
        expect(empty.container.querySelectorAll("[data-open='true']")).toHaveLength(5);
        expect(
            empty.container
                .querySelector("[data-seat-row]")
                ?.getAttribute("data-infeasible")
        ).toBe("false");
        cleanup();
        const one = render(() => <SeatRow ids={["Jinx"]} side="red" size="compact" />);
        expectSeats(one.container, { adc: { occupant: "Jinx" } });
        expect(one.container.querySelectorAll("[data-open='true']")).toHaveLength(4);
    });
    test("10 · a messy five: Tahm Kench top, Poppy jungle, Diana mid, Jinx adc, Neeko support", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Poppy", "TahmKench", "Neeko", "Jinx", "Diana"]}
                side="blue"
                size="compact"
            />
        ));
        expectSeats(container, {
            top: { occupant: "TahmKench" },
            jungle: { occupant: "Poppy" },
            mid: { occupant: "Diana" },
            adc: { occupant: "Jinx" },
            support: { occupant: "Neeko" }
        });
        expect(container.querySelectorAll("[data-count]")).toHaveLength(0);
    });
});

describe("SeatRow — ban slash, glyph tint, sizes", () => {
    test("slashCandidate draws the slash on the candidate's ring only (a ban card: Caitlyn denied to Blue's Gragas)", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Gragas", "Caitlyn"]}
                candidateIds={["Caitlyn"]}
                side="blue"
                size="card"
                slashCandidate={true}
            />
        ));
        expect(
            container
                .querySelector(
                    "[data-seat='adc'] [data-seat-ring][data-champion='Caitlyn']"
                )
                ?.getAttribute("data-slash")
        ).toBe("true");
        expect(
            container
                .querySelector(
                    "[data-seat='top'] [data-seat-ring][data-champion='Gragas']"
                )
                ?.getAttribute("data-slash")
        ).toBe("false");
        expect(
            container.querySelector("[data-seat='adc']")?.getAttribute("data-marker")
        ).toBe("candidate");
    });
    test("every seat starts with its role glyph tinted in ROLE_COLOR (U6)", () => {
        const { container } = render(() => (
            <SeatRow ids={[]} side="blue" size="compact" />
        ));
        const glyph = container.querySelector("[data-seat='top'] span");
        expect(glyph?.classList.contains("bg-red-400")).toBe(true);
        expect(glyph?.getAttribute("aria-label")).toBe("Top");
        expect(
            container
                .querySelector("[data-seat='support'] span")
                ?.classList.contains("bg-purple-400")
        ).toBe(true);
    });
    test("a ban row never flips red: Jinx denied to a Blue side that already has Xayah sits at adc with the sky marker and a count (decision 15 option a)", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Gragas", "Hecarim", "Akali", "Xayah", "Jinx"]}
                candidateIds={["Jinx"]}
                side="blue"
                size="card"
                slashCandidate={true}
            />
        ));
        expect(
            container.querySelector("[data-seat-row]")?.getAttribute("data-infeasible")
        ).toBe("false");
        expectSeats(container, {
            adc: { occupant: "Jinx", marker: "candidate", count: "2" },
            top: { occupant: "Gragas", marker: "none" }
        });
        expect(
            container
                .querySelector("[data-seat='adc'] [data-seat-ring]")
                ?.getAttribute("data-slash")
        ).toBe("true");
    });
    test("an infeasible PICK-turn row (no slash) stays red: denyMode is coupled to slashCandidate only", () => {
        const { container } = render(() => (
            <SeatRow
                ids={["Jinx", "Aphelios"]}
                candidateIds={["Aphelios"]}
                side="red"
                size="card"
            />
        ));
        expect(
            container.querySelector("[data-seat-row]")?.getAttribute("data-infeasible")
        ).toBe("true");
        expectSeats(container, {
            adc: { occupant: "Jinx", marker: "infeasible", count: "2" }
        });
        expect(container.querySelector("[data-marker='candidate']")).toBeNull(); // a wasted pick, not a sky candidate
    });
    test("the row is reactive: adding Ashe to Jinx fills the support seat without a remount", () => {
        const [ids, setIds] = createSignal(["Jinx"]);
        const { container } = render(() => (
            <SeatRow ids={ids()} side="red" size="compact" />
        ));
        expect(
            container.querySelector("[data-seat='support']")?.getAttribute("data-open")
        ).toBe("true");
        const adcBefore = container.querySelector("[data-seat='adc']");
        setIds(["Jinx", "Ashe"]);
        expect(
            container
                .querySelector("[data-seat='support']")
                ?.getAttribute("data-occupant")
        ).toBe("Ashe");
        expect(container.querySelector("[data-seat='adc']")).toBe(adcBefore); // Index keeps the five seat nodes
    });
    test("compact rings are 26px, card rings 30px (18 + 4 + 4 / 22 + 4 + 4)", () => {
        const compact = render(() => (
            <SeatRow ids={["Jinx"]} side="red" size="compact" />
        ));
        const c = compact.container.querySelector("[data-seat-ring]");
        expect(c instanceof HTMLElement ? c.style.width : "").toBe("26px");
        cleanup();
        const card = render(() => <SeatRow ids={["Jinx"]} side="red" size="card" />);
        const k = card.container.querySelector("[data-seat-ring]");
        expect(k instanceof HTMLElement ? k.style.width : "").toBe("30px");
    });
});
