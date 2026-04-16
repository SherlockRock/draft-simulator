interface PanzoomOptions {
    smoothScroll?: boolean;
    bounds?: boolean;
    boundsPadding?: number;
    maxZoom?: number;
    minZoom?: number;
}

interface PanzoomInstance {
    dispose: () => void;
}

function clamp(value: number, min: number, max: number) {
    return Math.min(max, Math.max(min, value));
}

function svgPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
    const point = svg.createSVGPoint();
    point.x = clientX;
    point.y = clientY;

    const matrix = svg.getScreenCTM();
    if (!matrix) {
        return { x: clientX, y: clientY };
    }

    const transformed = point.matrixTransform(matrix.inverse());
    return { x: transformed.x, y: transformed.y };
}

export default function panzoom(
    element: SVGGElement,
    options: PanzoomOptions = {}
): PanzoomInstance {
    const svg = element.ownerSVGElement;
    const minZoom = options.minZoom ?? 0.3;
    const maxZoom = options.maxZoom ?? 3;
    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    let dragging = false;
    let lastClientX = 0;
    let lastClientY = 0;

    if (!svg) {
        return {
            dispose: () => undefined
        };
    }

    const applyTransform = () => {
        element.setAttribute(
            "transform",
            `translate(${translateX} ${translateY}) scale(${scale})`
        );
    };

    const handleWheel = (event: WheelEvent) => {
        event.preventDefault();

        const cursor = svgPoint(svg, event.clientX, event.clientY);
        const zoomDelta = event.deltaY < 0 ? 1.1 : 0.9;
        const nextScale = clamp(scale * zoomDelta, minZoom, maxZoom);

        if (nextScale === scale) {
            return;
        }

        translateX = cursor.x - ((cursor.x - translateX) / scale) * nextScale;
        translateY = cursor.y - ((cursor.y - translateY) / scale) * nextScale;
        scale = nextScale;
        applyTransform();
    };

    const handleMouseDown = (event: MouseEvent) => {
        if (event.button !== 0) {
            return;
        }

        dragging = true;
        lastClientX = event.clientX;
        lastClientY = event.clientY;
        svg.style.cursor = "grabbing";
    };

    const handleMouseMove = (event: MouseEvent) => {
        if (!dragging) {
            return;
        }

        translateX += event.clientX - lastClientX;
        translateY += event.clientY - lastClientY;
        lastClientX = event.clientX;
        lastClientY = event.clientY;
        applyTransform();
    };

    const handleMouseUp = () => {
        dragging = false;
        svg.style.cursor = "grab";
    };

    svg.style.cursor = "grab";
    svg.addEventListener("wheel", handleWheel, { passive: false });
    svg.addEventListener("mousedown", handleMouseDown);
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    applyTransform();

    return {
        dispose: () => {
            svg.removeEventListener("wheel", handleWheel);
            svg.removeEventListener("mousedown", handleMouseDown);
            window.removeEventListener("mousemove", handleMouseMove);
            window.removeEventListener("mouseup", handleMouseUp);
            svg.style.cursor = "";
        }
    };
}
