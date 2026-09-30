import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
  effect,
  signal
} from '@angular/core';

import * as Cesium from 'cesium';
import { CommonModule } from '@angular/common';
import { BeamHit, CesiumRadarCoverage } from './CesiumRadarCoverage';
import { CesiumCoverageExplainer } from './CesiumCoverageExplainer';
import { CesiumPlacement } from './CesiumPlacement';
import { CesiumEntityRenderer } from "./CesiumEntityRenderer";
import { CesiumHover } from "./CesiumHover";
import { TeamFilter } from '../../core/models/TeamFilter';
import { EntityRepository } from "../../core/services/EntityRepository";
import { EditorState } from '../../core/state/EditorState';
import { TeamFilterService } from '../../core/services/TeamFilterService';
import { MapSyncService } from '../../core/services/MapSync';
import { CesiumSelection } from "./CesiumSelection";
import { CesiumGlbManager, PlacedGlb } from "./CesiumGlbManager";
import { BuildingLayer } from './layers/BuildingLayer';
import { CesiumObjectDetector } from './CesiumObjectDetector';



Cesium.Ion.defaultAccessToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiIxNzFhZjQzZC0xNGNmLTQyNDAtOTFlMC1jMmEyMDQwOTExNDAiLCJpZCI6NDQyMjYxLCJzdWIiOiJIYXJzaW1hcjA4IiwiaXNzIjoiaHR0cHM6Ly9hcGkuY2VzaXVtLmNvbSIsImF1ZCI6Im1pc3Npb24iLCJpYXQiOjE3ODQwMDU4MjB9.NzxkVB0Hlz8uYySEa5PaSg7bycWumdeeUXiaJgk57XY';
@Component({
  selector: 'app-cesium-map',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './cesium-map.html',
  styleUrl: './cesium-map.css'
})
export class CesiumMap implements AfterViewInit, OnDestroy {

  constructor() {

    effect(() => {

      const state = this.mapSync.state();

      if (!this.viewer) return;



      if (state.source === 'cesium') {
        return;
      }

      const current = this.viewer.camera.positionCartographic;


      const lat = Cesium.Math.toDegrees(current.latitude);
      const lon = Cesium.Math.toDegrees(current.longitude);

      if (

        Math.abs(lat - state.latitude) > 0.0001 ||

        Math.abs(lon - state.longitude) > 0.0001

      ) {
        this.syncing = true;

        this.viewer.camera.setView({

          destination: Cesium.Cartesian3.fromDegrees(
            state.longitude,
            state.latitude,
            this.mapSync.leafletZoomToHeight(
              state.zoom,
              state.latitude,
              this.viewer.scene.canvas.clientHeight
            )
          )

        });

        clearTimeout(this.syncTimeout);

        this.syncTimeout = setTimeout(() => {

          this.syncing = false;

        }, 100);
      }

    });


    effect(() => {

      const entities = this.entityRepository.all();

      // Make this effect rerun when selection changes
      this.editorState.selectedEntity();
      const filter = this.teamFilterService.cesiumFilter();

      if (this.renderer) {

        this.renderer.render(entities);


      }

    });

    // Re-open the radar panel automatically whenever a *different* entity
    // gets selected, but respect an explicit close (X) for the current one.
    effect(() => {
      const selected = this.editorState.selectedEntity();
      const id = selected?.id ?? null;

      if (id !== this.lastSelectedEntityId) {
        this.lastSelectedEntityId = id;
        this.radarPanelClosed.set(false);
      }
    });

  }

  @ViewChild('cesiumContainer', { static: true })
  cesiumContainer!: ElementRef<HTMLDivElement>;

  private viewer!: Cesium.Viewer;
  private readonly mapSync = inject(MapSyncService);
  private renderer!: CesiumEntityRenderer;
  public readonly teamFilterService = inject(TeamFilterService);
  private placement!: CesiumPlacement;
  private hover!: CesiumHover;
  private selection!: CesiumSelection;
  private coverageExplainer?: CesiumCoverageExplainer;
  // Bumped per explain click, so a slow terrain lookup can't overwrite a newer one.
  private explainRequest = 0;
  private objectDetector!: CesiumObjectDetector;
  protected readonly TeamFilter = TeamFilter;

  private readonly entityRepository = inject(EntityRepository);
  protected readonly editorState = inject(EditorState);

  private animationFrame?: number;

  private syncing = false;
  private syncTimeout?: ReturnType<typeof setTimeout>;
  private cesiumSyncFrame: number | null = null;

  private lastSelectedEntityId: string | null = null;
  protected readonly radarPanelClosed = signal(false);

  private glbManager!: CesiumGlbManager;
  protected readonly placedGlbs = signal<PlacedGlb[]>([]);
  protected readonly glbBusy = signal(false);

  async ngAfterViewInit(): Promise<void> {

    const terrainProvider =
      await Cesium.createWorldTerrainAsync();

    this.viewer = new Cesium.Viewer(
      this.cesiumContainer.nativeElement,
      {
        terrainProvider: terrainProvider,

        animation: false,
        timeline: false,
        baseLayerPicker: false,
        geocoder: false,
        homeButton: true,
        sceneModePicker: true,
        navigationHelpButton: true,
        fullscreenButton: true,
        infoBox: false,
        selectionIndicator: false,
        requestRenderMode: true,

        maximumRenderTimeChange: Infinity,
        terrainShadows: Cesium.ShadowMode.RECEIVE_ONLY,
      }
    );

    console.log(
      "TERRAIN PROVIDER:",
      terrainProvider
    );



    this.viewer.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(
        78.04386500,   // longitude
        30.34014610,   // latitude
        800            // camera height in meters
      ),
      orientation: {
        heading: 0.0,
        pitch: Cesium.Math.toRadians(-45),
        roll: 0.0
      }
    });
    console.log(
      this.viewer.scene.screenSpaceCameraController.enableZoom
    );
    this.viewer.scene.screenSpaceCameraController.enableZoom = true;
    this.viewer.scene.screenSpaceCameraController.enableRotate = true;
    this.viewer.scene.screenSpaceCameraController.enableTilt = true;
    this.viewer.scene.screenSpaceCameraController.enableTranslate = true;
    this.viewer.scene.screenSpaceCameraController.enableLook = true;



    this.viewer.scene.fog.enabled = false;

    this.viewer.scene.globe.enableLighting = false;

    this.viewer.scene.light = new Cesium.SunLight({
      intensity: 1.6
    });

    this.viewer.scene.globe.depthTestAgainstTerrain = true;


    await BuildingLayer.load(this.viewer);

    await this.loadTestGLBs();


    this.renderer = new CesiumEntityRenderer(
      this.viewer,
      terrainProvider,
      this.teamFilterService,
      this.editorState
    );


    this.renderer.render(this.entityRepository.all());


    this.placement = new CesiumPlacement(

      this.viewer,

      this.editorState,

      this.entityRepository

    );

    this.coverageExplainer = new CesiumCoverageExplainer(this.viewer);

    this.selection = new CesiumSelection(

      this.viewer,

      this.editorState,

      this.entityRepository

    );

    this.glbManager = new CesiumGlbManager(
      this.viewer,
      terrainProvider,
      () => this.rebuildAllRadarCoverage()
    );

    // this.hover = new CesiumHover(
    //     this.viewer
    // );



    //     const handler = new Cesium.ScreenSpaceEventHandler(
    //       this.viewer.scene.canvas
    //     );

    const handler = new Cesium.ScreenSpaceEventHandler(
      this.viewer.scene.canvas
    );

    handler.setInputAction(
      this.handleLeftClick.bind(this),
      Cesium.ScreenSpaceEventType.LEFT_CLICK
    );
    //     handler.setInputAction(

    //       this.handleLeftClick.bind(this),

    //       Cesium.ScreenSpaceEventType.LEFT_CLICK

    //     );
    //     handler.setInputAction(

    //     this.hover.handleMouseMove.bind(this.hover),

    //     Cesium.ScreenSpaceEventType.MOUSE_MOVE

    // );



    this.viewer.camera.moveStart.addEventListener(() => {

      this.startCesiumCameraLoop();

    });

    this.viewer.camera.moveEnd.addEventListener(() => {

      this.stopCesiumCameraLoop();

    });

    // this.viewer.camera.changed.addEventListener(() => {
    //   this.viewer.scene.requestRender();
    // });
    this.viewer.scene.requestRender();
  }

  private startCesiumCameraLoop(): void {

    if (this.cesiumSyncFrame !== null) {
      return;
    }

    const tick = () => {

      if (!this.viewer || this.syncing) {

        this.cesiumSyncFrame = null;
        return;

      }

      const camera = this.viewer.camera.positionCartographic;

      const latitude = Cesium.Math.toDegrees(camera.latitude);
      const longitude = Cesium.Math.toDegrees(camera.longitude);

      const zoom = this.mapSync.heightToLeafletZoom(
        camera.height,
        latitude,
        this.viewer.scene.canvas.clientHeight
      );



      this.mapSync.update({

        latitude,
        longitude,
        zoom,
        source: 'cesium'

      });

      this.cesiumSyncFrame = requestAnimationFrame(tick);

    };

    this.cesiumSyncFrame = requestAnimationFrame(tick);

  }


  private stopCesiumCameraLoop(): void {

    if (this.cesiumSyncFrame !== null) {

      cancelAnimationFrame(this.cesiumSyncFrame);

      this.cesiumSyncFrame = null;

    }

  }

  setAllForces() {

    this.teamFilterService.setCesiumFilter(
      TeamFilter.All
    );

  }


  setBlueForces() {

    this.teamFilterService.setCesiumFilter(
      TeamFilter.Blue
    );

  }


  setRedForces() {

    this.teamFilterService.setCesiumFilter(
      TeamFilter.Red
    );

  }
  private isPointInPolygon(
    point: Cesium.Cartographic,
    polygon: Cesium.Cartographic[]
  ): boolean {

    let inside = false;

    for (
      let i = 0, j = polygon.length - 1;
      i < polygon.length;
      j = i++
    ) {

      const xi = Cesium.Math.toDegrees(polygon[i].longitude);
      const yi = Cesium.Math.toDegrees(polygon[i].latitude);

      const xj = Cesium.Math.toDegrees(polygon[j].longitude);
      const yj = Cesium.Math.toDegrees(polygon[j].latitude);

      const x = Cesium.Math.toDegrees(point.longitude);
      const y = Cesium.Math.toDegrees(point.latitude);

      const intersect =
        ((yi > y) !== (yj > y)) &&
        (x <
          (xj - xi) *
          (y - yi) /
          (yj - yi) +
          xi);

      if (intersect) {
        inside = !inside;
      }
    }

    return inside;
  }

  // Full zone configs (name + color + defaults) for the panel
  protected readonly radarZones = CesiumRadarCoverage.DEFAULT_3D_ZONES;

  private getRadarProps(): Record<string, any> {
    return (this.editorState.selectedEntity()?.definition?.properties as any) ?? {};
  }

  protected getRadarProp<T>(key: string, fallback: T): T {
    return this.getRadarProps()[key] ?? fallback;
  }

  protected getZoneVisible(zone: string): boolean {
    return (this.getRadarProps()['zoneVisibility']?.[zone]) ?? true;
  }

  protected getZoneRange(zone: string): number | null {
    return this.getRadarProps()['zoneRanges']?.[zone] ?? null;
  }

  protected getZoneMaxElevation(zone: string): number | null {
    return this.getRadarProps()['zoneElevations']?.[zone]?.max ?? null;
  }

  protected zoneDefaultRange(zoneName: string): number {
    return this.radarZones.find(z => z.name === zoneName)?.defaultRange ?? 0;
  }

  protected zoneDefaultMaxElevation(zoneName: string): number {
    return this.radarZones.find(z => z.name === zoneName)?.defaultMaxElevationDeg ?? 0;
  }

  onSectorStartChange(value: string): void {
    this.updateRadarProperty({ sectorStartDeg: +value });
  }

  onSectorSweepChange(value: string): void {
    this.updateRadarProperty({ sectorSweepDeg: +value });
  }

  onElevationChange(value: string): void {
    this.updateRadarProperty({ antennaMastHeight: +value });
  }

  onZoneVisibilityChange(zone: string, checked: boolean): void {
    const current = this.getRadarProp<Record<string, boolean>>('zoneVisibility', {});
    this.updateRadarProperty({ zoneVisibility: { ...current, [zone]: checked } });
  }

  onZoneRangeChange(zone: string, value: string): void {
    const current = this.getRadarProp<Record<string, number>>('zoneRanges', {});
    this.updateRadarProperty({ zoneRanges: { ...current, [zone]: +value } });
  }

  onZoneMaxElevationChange(zone: string, value: string): void {
    const current = this.getRadarProp<Record<string, { min: number; max: number }>>('zoneElevations', {});
    this.updateRadarProperty({
      zoneElevations: { ...current, [zone]: { ...current[zone], min: current[zone]?.min ?? 0, max: +value } }
    });
  }

  onDrawRaysChange(checked: boolean): void {
    this.updateRadarProperty({ drawRays: checked });
  }

  onBeamOpacityChange(value: string): void {
  const opacity = Math.max(
    0,
    Math.min(1, +value)
  );

  this.updateRadarProperty({
    beamOpacity: opacity
  });
}

onInteriorOpacityChange(value: string): void {
  const opacity = Math.max(
    0,
    Math.min(0.30, +value)
  );

  this.updateRadarProperty({
    interiorOpacity: opacity
  });
}

onInteriorToggle(checked: boolean): void {
  this.updateRadarProperty({
    showInterior: checked
  });
}

  onShowBlockedPointsChange(checked: boolean): void {
    this.updateRadarProperty({ showBlockedPoints: checked });
  }

  onExplainOnClickChange(checked: boolean): void {
    this.updateRadarProperty({ explainOnClick: checked });
    if (!checked) {
      this.clearCoverageInfo();
    }
  }

  toggleDrawRays(): void {
    this.onDrawRaysChange(!this.getRadarProp('drawRays', false));
  }

  refreshRadarCoverage(): void {
    const entity = this.editorState.selectedEntity();
    if (!entity || entity.definition.entityType !== 'RadarSite') return;

    this.renderer?.forceRebuild(entity.id);
    this.renderer?.render(this.entityRepository.all());
  }

  closeRadarPanel(): void {
    this.radarPanelClosed.set(true);
  }

  /** Rebuilds every radar's coverage, e.g. after an obstacle moved or resized. */
  private rebuildAllRadarCoverage(): void {

    if (!this.renderer) {
      return;
    }

    const entities = this.entityRepository.all();

    for (const entity of entities) {
      if (entity.definition.entityType === 'RadarSite') {
        this.renderer.forceRebuild(entity.id);
      }
    }

    this.renderer.render(entities);
  }

  async onGlbFileSelected(event: Event): Promise<void> {

    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (!file) {
      return;
    }

    this.glbBusy.set(true);

    try {
      await this.glbManager.addFromFile(file, 0, 1);
      this.placedGlbs.set([...this.glbManager.list()]);
    } catch (err) {
      console.error('Failed to load GLB:', err);
    } finally {
      this.glbBusy.set(false);
      // Allow re-selecting the same file.
      input.value = '';
    }
  }

  onGlbScaleChange(id: string, value: string): void {
    this.glbManager.setScale(id, +value);
    this.placedGlbs.set([...this.glbManager.list()]);
  }

  onGlbHeightChange(id: string, value: string): void {
    this.glbManager.setHeight(id, +value);
    this.placedGlbs.set([...this.glbManager.list()]);
  }

  removeGlb(id: string): void {
    this.glbManager.remove(id);
    this.placedGlbs.set([...this.glbManager.list()]);
  }

  flyToGlb(glb: PlacedGlb): void {
    this.viewer.camera.flyToBoundingSphere(glb.model.boundingSphere, { duration: 1 });
  }

  updateRadarProperty(patch: Record<string, unknown>): void {
    const entity = this.editorState.selectedEntity();
    if (!entity || entity.definition.entityType !== 'RadarSite') return;

    const updatedProperties = { ...entity.definition.properties, ...patch };
    const updatedEntity = {
      ...entity,
      definition: { ...entity.definition, properties: updatedProperties }
    };

    this.entityRepository.update(entity.id, { definition: updatedEntity.definition });
    this.editorState.selectedEntity.set(updatedEntity);
  }

  private handleLeftClick(
    click: Cesium.ScreenSpaceEventHandler.PositionedEvent
  ): void {

    // Get terrain position at clicked location
    const cartesian = this.viewer.scene.pickPosition(click.position);

    if (Cesium.defined(cartesian)) {

      const cartographic =
        Cesium.Cartographic.fromCartesian(cartesian);

      const longitude =
        Cesium.Math.toDegrees(cartographic.longitude);

      const latitude =
        Cesium.Math.toDegrees(cartographic.latitude);

      const height =
        cartographic.height;

      console.log("CLICKED LOCATION");
      console.log("Longitude:", longitude);
      console.log("Latitude:", latitude);
      console.log("Height:", height);
    }

    if (!this.editorState.placementMode() && this.tryExplainCoverage(click)) {
      return;
    }

    if (this.editorState.placementMode()) {

      this.placement.placeEntity(click);

    } else {

      this.selection.selectEntity(click);

      // Selecting the same radar again doesn't change the selection, so the
      // panel effect doesn't fire; reopen the panel if it was closed.
      if (this.editorState.selectedEntity()?.definition?.entityType === 'RadarSite') {
        this.radarPanelClosed.set(false);
      }

    }
  }

  /**
   * While any radar has "Explain Coverage on Click" on, a click on the map
   * reports why that radar does or doesn't reach the spot, instead of changing
   * the selection. It keeps working with the radar panel closed. Clicking a
   * different entity still selects it.
   */
  private tryExplainCoverage(
    click: Cesium.ScreenSpaceEventHandler.PositionedEvent
  ): boolean {

    const entities = this.entityRepository.all();
    const radars = entities.filter(e =>
      e.definition.entityType === 'RadarSite' &&
      (e.definition.properties as any)?.explainOnClick
    );

    if (radars.length === 0) {
      return false;
    }

    // The beam volume is a primitive picked as the radar's id string; the radar
    // itself and other placed things are Cesium entities. Clicking an entity
    // (the radar marker included) selects it as usual, so its panel opens.
    const pickedId = this.viewer.scene.pick(click.position)?.id;

    if (pickedId && typeof pickedId !== 'string') {
      const id = pickedId.radarParentId ?? pickedId.id;
      if (entities.some(e => e.id === id)) {
        return false;
      }
    }

    // The beam of a radar that has the option off: select that radar.
    if (
      typeof pickedId === 'string' &&
      !radars.some(r => r.id === pickedId) &&
      entities.some(e => e.id === pickedId)
    ) {
      return false;
    }

    const ray = this.viewer.camera.getPickRay(click.position);
    const ground = this.viewer.scene.pickPosition(click.position);

    if (!ray) {
      return false;
    }

    // Did the click pass through a drawn beam before reaching the ground (or,
    // clicking the sky, within 100 km)? The nearest beam entry wins.
    const rayEnd = ground ?? Cesium.Ray.getPoint(ray, 100000);
    let airHit: { radarId: string; hit: BeamHit; distance: number } | undefined;

    for (const radar of radars) {
      const hit = CesiumRadarCoverage.findBeamEntry(radar.id, ray.origin, rayEnd);
      if (hit) {
        const distance = Cesium.Cartesian3.distance(ray.origin, hit.position);
        if (!airHit || distance < airHit.distance) {
          airHit = { radarId: radar.id, hit, distance };
        }
      }
    }

    let radarId: string;
    let target: Cesium.Cartesian3;

    if (airHit) {
      radarId = airHit.radarId;
      target = airHit.hit.position;
    } else if (Cesium.defined(ground)) {
      // Ground click: prefer the selected radar, otherwise the nearest one.
      const selectedId = this.editorState.selectedEntity()?.id;
      const distanceTo = (e: typeof radars[number]) => Cesium.Cartesian3.distance(
        ground,
        Cesium.Cartesian3.fromDegrees(e.position.longitude, e.position.latitude)
      );
      radarId = (
        radars.find(r => r.id === selectedId)
        ?? radars.reduce((best, r) => distanceTo(r) < distanceTo(best) ? r : best)
      ).id;
      target = ground;
    } else {
      return false;
    }

    const request = ++this.explainRequest;
    this.coverageExplainer?.showMessage(target, 'Checking the terrain…');

    CesiumRadarCoverage.explainPoint(radarId, target, airHit?.hit)
      .then(explanation => {
        if (request !== this.explainRequest) {
          return;
        }
        if (explanation) {
          this.coverageExplainer?.show(explanation);
        } else {
          this.coverageExplainer?.showMessage(
            target,
            'Coverage is still being built, or all zones are hidden'
          );
        }
      })
      .catch(err => {
        console.error('Failed to explain coverage:', err);
        if (request === this.explainRequest) {
          this.coverageExplainer?.showMessage(target, 'Could not read the terrain here');
        }
      });

    return true;
  }

  clearCoverageInfo(): void {
    this.explainRequest++;
    this.coverageExplainer?.clear();
  }

  public resize(): void {

    this.viewer.resize();

  }


 private async loadTestGLBs(): Promise<void> {

  const longitude = 74.89513005356172;
  const latitude = 31.54178024749536;
  const terrainHeight = 179.27878368853075;

  const height = terrainHeight + 20;

  const model = await Cesium.Model.fromGltfAsync({
    url: 'assets/models/F_16.glb',

    scale: 50,

    modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(
      Cesium.Cartesian3.fromDegrees(
        longitude,
        latitude,
        height
      )
    )
  });

  this.viewer.scene.primitives.add(model);

  console.log("F16 ADDED TO SCENE");
  console.log("MODEL READY:", model.ready);

  model.readyEvent.addEventListener(() => {

  console.log("========== F16 READY ==========");
  console.log("MODEL READY:", model.ready);

  const sphere = model.boundingSphere;

  console.log("CENTER:", sphere.center);
  console.log("RADIUS:", sphere.radius);

  console.log("================================");
});

  console.log("STARTING FLY TO F16");

  this.viewer.camera.flyTo({
    destination: Cesium.Cartesian3.fromDegrees(
      longitude,
      latitude,
      500
    ),
    duration: 2
  });
}

  ngOnDestroy(): void {

    this.viewer.destroy();

  }

}