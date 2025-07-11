import "solid-js";

declare module "solid-js" {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    namespace JSX {
        interface Directives {
            draggable: boolean;
            droppable: boolean;
            sortable: boolean;
        }
    }
}
