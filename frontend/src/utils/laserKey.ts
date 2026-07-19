// Minimal keyboard-event surface so the state machine tests need no DOM.
type LaserKeyDownEvent = {
    key: string;
    repeat: boolean;
    preventDefault: () => void;
};

type LaserKeyUpEvent = { key: string };

// Tab-hold lifecycle for the laser pointer, extracted from Canvas.tsx so the
// transitions are unit-testable. Owns exactly one bit — "is a hold active" —
// and guarantees onDeactivate fires once per hold no matter how it ends
// (keyup, window blur, visibilitychange; the latter two cover the missed
// keyup after alt-tab). The canActivate guard keeps Tab's focus navigation
// working whenever an interactive element is focused; a repeat never
// activates, so a Tab held before the guard opened cannot start drawing
// mid-hold.
export function createLaserKeyTracker(options: {
    canActivate: () => boolean;
    onActivate: () => void;
    onDeactivate: () => void;
}) {
    let isActive = false;

    const deactivate = () => {
        if (!isActive) return;
        isActive = false;
        options.onDeactivate();
    };

    return {
        active: () => isActive,

        handleKeyDown(event: LaserKeyDownEvent) {
            if (event.key !== "Tab") return;
            if (isActive) {
                // Holding Tab fires key-repeats; unhandled ones would move
                // focus mid-stroke.
                event.preventDefault();
                return;
            }
            if (event.repeat) return;
            if (!options.canActivate()) return;
            event.preventDefault();
            isActive = true;
            options.onActivate();
        },

        handleKeyUp(event: LaserKeyUpEvent) {
            if (event.key !== "Tab") return;
            deactivate();
        },

        deactivate
    };
}
