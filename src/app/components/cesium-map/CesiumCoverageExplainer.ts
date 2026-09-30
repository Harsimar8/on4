import * as Cesium from "cesium";
import { CoverageExplanation } from "./CesiumRadarCoverage";

// Shows the result of CesiumRadarCoverage.explainPoint on the map: a compact
// label at the clicked spot and, when a mountain hides it, the crest plus the
// radar-to-spot sight line, drawn through the mountain so it can be seen.
// The spot's label sits above its point and the crest's below its point, so
// the two never overlap. Only one explanation is shown at a time.
export class CesiumCoverageExplainer {

    private shown: Cesium.Entity[] = [];

    constructor(private readonly viewer: Cesium.Viewer) {}

    show(explanation: CoverageExplanation): void {
        this.clear();

        const red = Cesium.Color.fromCssColorString("#ef4444");
        const green = Cesium.Color.fromCssColorString("#22c55e");

        this.addPoint(explanation.targetPosition, explanation.visible ? green : red, {
            text: explanation.lines.join("\n"),
            font: "12px sans-serif",
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#0f172a").withAlpha(0.88),
            backgroundPadding: new Cesium.Cartesian2(8, 6),
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });

        if (explanation.groundPosition) {
            // Air point: drop a line to the ground below so its height reads at a glance.
            const white = new Cesium.PolylineDashMaterialProperty({ color: Cesium.Color.WHITE, dashLength: 8 });
            this.add({
                polyline: {
                    positions: [explanation.targetPosition, explanation.groundPosition],
                    arcType: Cesium.ArcType.NONE,
                    width: 1.5,
                    material: white,
                    depthFailMaterial: white
                }
            });
        }

        const blocker = explanation.blocker;
        if (blocker) {
            const dashed = new Cesium.PolylineDashMaterialProperty({ color: red, dashLength: 12 });

            this.add({
                polyline: {
                    positions: [explanation.radarPosition, explanation.targetPosition],
                    arcType: Cesium.ArcType.NONE,
                    width: 2,
                    material: dashed,
                    // Keep the part of the sight line that goes into the mountain visible.
                    depthFailMaterial: dashed
                }
            });

            this.addPoint(blocker.position, red, {
                text: "Mountain blocks the beam here",
                font: "12px sans-serif",
                fillColor: Cesium.Color.WHITE,
                showBackground: true,
                backgroundColor: red.withAlpha(0.9),
                backgroundPadding: new Cesium.Cartesian2(6, 4),
                verticalOrigin: Cesium.VerticalOrigin.TOP,
                pixelOffset: new Cesium.Cartesian2(0, 12),
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            });
        }

        this.viewer.scene.requestRender();
    }

    showMessage(position: Cesium.Cartesian3, text: string): void {
        this.clear();
        this.addPoint(position, Cesium.Color.WHITE, {
            text,
            font: "12px sans-serif",
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.fromCssColorString("#0f172a").withAlpha(0.88),
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: new Cesium.Cartesian2(0, -14),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
        });
        this.viewer.scene.requestRender();
    }

    clear(): void {
        for (const entity of this.shown) {
            this.viewer.entities.remove(entity);
        }
        this.shown = [];
        this.viewer.scene.requestRender();
    }

    private addPoint(
        position: Cesium.Cartesian3,
        color: Cesium.Color,
        label: Cesium.LabelGraphics.ConstructorOptions
    ): void {
        this.add({
            position,
            point: {
                pixelSize: 10,
                color,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 2,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            },
            label
        });
    }

    private add(options: Cesium.Entity.ConstructorOptions): void {
        this.shown.push(this.viewer.entities.add(options));
    }
}
