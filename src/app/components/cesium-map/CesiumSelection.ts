import * as Cesium from "cesium";

import { EditorState } from "../../core/state/EditorState";
import { EntityRepository } from "../../core/services/EntityRepository";

export class CesiumSelection {

    constructor(
        private viewer: Cesium.Viewer,
        private editorState: EditorState,
        private entityRepository: EntityRepository
    ) {}

    selectEntity(
        click: Cesium.ScreenSpaceEventHandler.PositionedEvent
    ): void {

        // drillPick so a click anywhere on the radar - beam volume, blocked-point
        // dots or emitter marker - still selects it when something else is on top.
        const pickedList = this.viewer.scene.drillPick(click.position);

        if (pickedList.length === 0) {
            this.editorState.selectedEntity.set(null);
            return;
        }

        const entities = this.entityRepository.all();

        for (const picked of pickedList) {

            const targetId = this.resolveTargetId((picked as any).id);

            const entity = targetId
                ? entities.find(e => e.id === targetId)
                : undefined;

            if (entity) {
                this.editorState.selectedEntity.set(entity);
                return;
            }
        }
    }

    // The radar beam volume is a Primitive whose pick id is the radar's id
    // string; markers and dots are Entities tagged with radarParentId.
    private resolveTargetId(pickedId: any): string | undefined {

        if (!pickedId) {
            return undefined;
        }

        if (typeof pickedId === "string") {
            return pickedId;
        }

        return pickedId.radarParentId || pickedId.id;
    }
}