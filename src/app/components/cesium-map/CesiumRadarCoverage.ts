import * as Cesium from "cesium";
import { CesiumObjectDetector } from "./CesiumObjectDetector";

// =============================================================================
// Types
// =============================================================================

export interface RadarOptions {
    entityId: string;
    longitude: number;
    latitude: number;
    altitude?: number;
    mastHeight?: number;
    sectorStartDeg?: number;
    sectorSweepDeg?: number;
    drawRays?: boolean;
    azimuthStepDeg?: number;
    rangeSampleSteps?: number;
    elevationRingsPerZone?: number;
    useObjectPicking?: boolean;
    zoneOverrides?: Record<string, RadarZoneOverride>;
    beamOpacity?: number;
    interiorOpacity?: number;
    showInterior?: boolean;
    interiorLayers?: number;
    showBlockedPoints?: boolean;
}

export interface RadarZoneOverride {
    visible?: boolean;
    range?: number;
    minElevationDeg?: number;
    maxElevationDeg?: number;
    azimuthStartDeg?: number;
    azimuthWidthDeg?: number;
    color?: string;
    beamOpacity?: number;
    interiorOpacity?: number;
    showInterior?: boolean;
}

export interface RadarZoneConfig {
    name: string;
    cssColor: string;
    color: Cesium.Color;
    defaultRange: number;
    defaultMinElevationDeg: number;
    defaultMaxElevationDeg: number;
}

interface ResolvedZone {
    name: string;
    color: Cesium.Color;
    range: number;
    // Elevation of every ray in this zone, e.g. 0,1,2,...,10 for a 0-10 deg zone.
    rayElevationsDeg: number[];
    beamOpacity: number;
    azimuthStartDeg: number;
    azimuthWidthDeg: number;
}

interface TerrainProfile {
    azimuthDeg: number;
    horizontalDistances: number[];
    groundHeights: number[];
    groundPoints: Cesium.Cartographic[];
}

interface RayStop {
    // Horizontal distance from the radar at which this ray ends.
    horizontalDistance: number;
    // Index into the profile of the terrain sample that stopped the ray, or -1 if unblocked.
    blockIndex: number;
}

export interface RadarCoverageHandle {
    dispose(): void;
}

export interface CoverageBlocker {
    // The crest on the exact radar-to-spot line that hides the spot.
    position: Cesium.Cartesian3;
    distanceM: number;
    groundHeightM: number;
}

export interface CoverageExplanation {
    radarPosition: Cesium.Cartesian3;
    targetPosition: Cesium.Cartesian3;
    // Set when the click was on the beam in the air: the ground straight below.
    groundPosition?: Cesium.Cartesian3;
    visible: boolean;
    // Short lines for the on-map label, most important first.
    lines: string[];
    blocker?: CoverageBlocker;
}

// The painted ground coverage image of one zone, kept so a click is judged by
// exactly what is shown on the map.
interface GroundRaster {
    seen: Uint8Array;
    size: number;
    west: number;
    north: number;
    dLatPx: number;
    dLonPx: number;
}

export interface BeamHit {
    position: Cesium.Cartesian3;
    zoneName: string;
}

// A zone's drawn beam, kept so a click can be tested against it.
interface ZoneBeam {
    zone: ResolvedZone;
    profiles: TerrainProfile[];
    azStepDeg: number;
    // shadowTan[a][i]: highest terrain elevation tangent along profile a up to
    // sample i. A ray at elevation tan e is blocked before sample i when this
    // exceeds e - the same test traceRay makes. Filled on first use.
    shadowTan: (Float64Array | undefined)[];
}

// Everything a finished build needs to explain a later click.
interface RadarAnalysis {
    radarPosition: Cesium.Cartesian3;
    enuMatrix: Cesium.Matrix4;
    radarHeight: number;
    terrainProvider: Cesium.TerrainProvider;
    zones: ResolvedZone[];
    // Smallest range first, so a point in several zones reports the innermost.
    beams: ZoneBeam[];
    rasters: Map<string, GroundRaster>;
}

// =============================================================================
// CesiumRadarCoverage (Multi-Ring Elevation Wedges with Terrain Masking)
// =============================================================================

const TERRAIN_SAMPLE_SPACING_M = 5;
// Terrain this close to the antenna never blocks it. The elevation model is
// only interpolated between its grid points here, and with the antenna at
// ground level (mast height 0) a few centimetres of that noise one sample away
// reads as a steep "mountain" that shadows everything behind it.
const NEAR_FIELD_IGNORE_M = 20;
// Terrain only blocks a ray when it rises at least this far above it. Grazing
// by less - e.g. an even slope that the Earth's curvature lowers by millimetres
// per sample - is well inside the elevation model's accuracy.
const GRAZE_TOLERANCE_M = 1;
const EARTH_RADIUS_M = 6371000;
const BLOCKED_POINT_ALWAYS_VISIBLE_M = 3000;

// The beam panel between two neighbouring ray end points is a straight chord,
// while the terrain between them bulges above and dips below it. Moving each
// vertex toward the eye along its view ray changes only its depth, not where it
// lands on screen, so the beam wins against terrain close behind it but is still
// hidden by ridges clearly in front.
//
// How far the terrain strays from a panel depends on how wide the panel is, and
// that grows with distance from the radar (width = range * azimuth step), not
// with camera distance. So the pull is set per vertex from its range to the
// radar, and zooming in no longer lets the terrain cut back through the beam.
const BEAM_DEPTH_PULL_PER_PANEL_WIDTH = 0.5;
const BEAM_DEPTH_PULL_MIN_M = 10.0;
// Cesium renders coarser terrain the farther the camera is (its error grows
// roughly linearly with camera distance), while the beam is built from the most
// detailed heights. This extra pull per metre of camera distance covers that
// level-of-detail gap so zooming out does not make hills poke through the beam.
const BEAM_DEPTH_PULL_PER_CAMERA_M = 0.004;
// Never pull a vertex more than this fraction of the way to the camera.
const BEAM_DEPTH_PULL_MAX_CAMERA_FRACTION = 0.8;

// Ground the beam actually reaches is painted onto the terrain as an image
// layer, so it follows the terrain exactly at every zoom level.
// Extra columns interpolated between two traced azimuths, so shadow edges run
// smoothly instead of in wedge-shaped steps.
const GROUND_SUBDIVISIONS = 8;
const GROUND_TEXTURE_MIN_M_PER_PX = 5;
const GROUND_TEXTURE_MAX_PX = 3072;
const GROUND_FILL_ALPHA = 90;
const GROUND_OUTLINE_ALPHA = 235;
const GROUND_RANGE_RING_ALPHA = 200;

// What the beam does at one terrain sample.
const GROUND_COVERED = 0;
const GROUND_BLOCKED = 1;
const GROUND_ABOVE_BEAM = 2;
const GROUND_BELOW_BEAM = 3;
const GROUND_OUT_OF_RANGE = 4;

// A crest this close in front of the clicked spot is the spot's own slope
// turning away from the radar rather than a separate mountain.
const OWN_SLOPE_BLOCKER_M = 30;

const buildBeamVS = (pullPerRangeM: number) => `
in vec3 position3DHigh;
in vec3 position3DLow;
in float rangeFromRadar;
in vec4 color;
in float batchId;

out vec4 v_color;

void main()
{
    vec4 p = czm_computePosition();
    vec4 positionEC = czm_modelViewRelativeToEye * p;

    float dist = length(positionEC.xyz);
    float pull = ${BEAM_DEPTH_PULL_MIN_M.toFixed(1)}
        + rangeFromRadar * ${pullPerRangeM.toFixed(5)}
        + dist * ${BEAM_DEPTH_PULL_PER_CAMERA_M.toFixed(4)};
    pull = min(pull, dist * ${BEAM_DEPTH_PULL_MAX_CAMERA_FRACTION.toFixed(2)});
    positionEC.xyz *= (dist - pull) / max(dist, 0.001);

    v_color = color;
    gl_Position = czm_projection * positionEC;
}
`;

const BEAM_FS = `
in vec4 v_color;

void main()
{
    out_FragColor = czm_gammaCorrect(v_color);
}
`;

export function formatDistance(m: number): string {
    return m < 1000 ? `${m.toFixed(0)} m` : `${(m / 1000).toFixed(2)} km`;
}

export class CesiumRadarCoverage {
    public static readonly DEFAULT_3D_ZONES: RadarZoneConfig[] = [
        {
            name: "Zone 1 (Low)",
            cssColor: "#22c55e",
            color: Cesium.Color.fromCssColorString("#22c55e"),
            defaultRange: 5000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 10
        },
        {
            name: "Zone 2 (Mid)",
            cssColor: "#f59e0b",
            color: Cesium.Color.fromCssColorString("#f59e0b"),
            defaultRange: 12000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 20
        },
        {
            name: "Zone 3 (High / Wide)",
            cssColor: "#ef4444",
            color: Cesium.Color.fromCssColorString("#ef4444"),
            defaultRange: 20000,
            defaultMinElevationDeg: 0,
            defaultMaxElevationDeg: 30
        }
    ];

    // Latest finished build per radar, read by explainPoint.
    private static readonly analyses = new Map<string, RadarAnalysis>();

    // -------------------------------------------------------------------
    // 1. Main Entry Point: create3DRadarZones
    // -------------------------------------------------------------------
    static async create3DRadarZones(
        viewer: Cesium.Viewer,
        terrainProvider: Cesium.TerrainProvider,
        options: RadarOptions
    ): Promise<RadarCoverageHandle[]> {

        const {
            entityId,
            longitude,
            latitude,
            mastHeight = 0,
            sectorStartDeg = 0,
            sectorSweepDeg = 360,
            azimuthStepDeg = 2,
            rangeSampleSteps,
            elevationRingsPerZone = 8,
            showBlockedPoints = false,
            zoneOverrides = {}
        } = options;

        const handles: RadarCoverageHandle[] = [];

        // Position & Terrain Sampling
        const cartographic = Cesium.Cartographic.fromDegrees(longitude, latitude);
        const [sampled] = await Cesium.sampleTerrainMostDetailed(terrainProvider, [cartographic]);
        const terrainHeight = sampled.height ?? 0;

        const radarPosition = Cesium.Cartesian3.fromDegrees(
            longitude,
            latitude,
            terrainHeight + mastHeight
        );

        const enuMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(radarPosition);
        const radarHeight = terrainHeight + mastHeight;

        // Emitter Marker
        const marker = viewer.entities.add({
            position: radarPosition,
            point: {
                pixelSize: 16,
                color: Cesium.Color.BLACK,
                outlineColor: Cesium.Color.WHITE,
                outlineWidth: 3,
                disableDepthTestDistance: Number.POSITIVE_INFINITY
            }
        });
        (marker as any).radarParentId = entityId;
        handles.push({ dispose: () => viewer.entities.remove(marker) });

        // Resolve Zones. Each zone is a fan of individual rays: one ray per
        // azimuth step and per elevation step, e.g. 0,1,2,...,10 deg for a
        // 0-10 deg zone split into 10 steps.
        const zones: ResolvedZone[] = [];
        for (const zoneConfig of CesiumRadarCoverage.DEFAULT_3D_ZONES) {
            const override = zoneOverrides[zoneConfig.name] ?? {};
            if (!(override.visible ?? true)) continue;

            const minEl = override.minElevationDeg ?? zoneConfig.defaultMinElevationDeg;
            const maxEl = override.maxElevationDeg ?? zoneConfig.defaultMaxElevationDeg;
            const steps = Math.max(1, elevationRingsPerZone);
            const rayElevationsDeg: number[] = [];
            for (let k = 0; k <= steps; k++) {
                rayElevationsDeg.push(minEl + ((maxEl - minEl) * k) / steps);
            }

            zones.push({
                name: zoneConfig.name,
                color: zoneConfig.color,
                range: override.range ?? zoneConfig.defaultRange,
                rayElevationsDeg,
                beamOpacity: override.beamOpacity ?? (options.beamOpacity ?? 0.35),
                azimuthStartDeg: override.azimuthStartDeg ?? sectorStartDeg,
                azimuthWidthDeg: override.azimuthWidthDeg ?? sectorSweepDeg
            });
        }

        if (zones.length === 0) return handles;

        // A terrain profile depends only on the azimuth fan and how far out we walk it -
        // not on a ray's elevation. Sample each distinct fan once, out to the largest
        // range any zone on it needs and at the finest spacing any of them asked for.
        const profileGroups = new Map<string, { maxRange: number; spacing: number }>();
        for (const zone of zones) {
            const key = `${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`;
            const spacing = rangeSampleSteps
                ? zone.range / Math.max(2, rangeSampleSteps)
                : TERRAIN_SAMPLE_SPACING_M;

            const group = profileGroups.get(key);
            if (group) {
                group.maxRange = Math.max(group.maxRange, zone.range);
                group.spacing = Math.min(group.spacing, spacing);
            } else {
                profileGroups.set(key, { maxRange: zone.range, spacing });
            }
        }

        const profilesByFan = new Map<string, TerrainProfile[]>();
        for (const [key, group] of profileGroups) {
            const [fanStartDeg, fanWidthDeg] = key.split("|").map(Number);
            const fanAzimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
                fanStartDeg,
                fanWidthDeg,
                azimuthStepDeg
            );

            profilesByFan.set(key, await CesiumRadarCoverage.buildTerrainProfiles(
                terrainProvider,
                radarPosition,
                enuMatrix,
                fanAzimuthsDeg,
                group.maxRange,
                group.spacing
            ));
        }

        // Terrain points that stopped a ray, keyed by fan|azimuth|sample so rays
        // stopped by the same ground only draw one marker (first zone's colour wins).
        const blockedPoints = new Map<string, { position: Cesium.Cartesian3; color: Cesium.Color }>();
        const groundJobs: { zone: ResolvedZone; profiles: TerrainProfile[] }[] = [];

        for (const zone of zones) {
            const azimuthsDeg = CesiumRadarCoverage.buildAzimuthList(
                zone.azimuthStartDeg,
                zone.azimuthWidthDeg,
                azimuthStepDeg
            );

            const fanKey = `${zone.azimuthStartDeg}|${zone.azimuthWidthDeg}`;
            const profiles = profilesByFan.get(fanKey)!;

            // stops[a][k] = where the ray at azimuth a and elevation k ends. Every
            // ray is traced on its own, so a hill that stops the low rays leaves
            // the higher rays free to pass over it.
            const stops = profiles.map(profile =>
                zone.rayElevationsDeg.map(elevationDeg =>
                    CesiumRadarCoverage.traceRay(profile, radarHeight, zone.range, elevationDeg)
                )
            );

            if (showBlockedPoints) {
                stops.forEach((rayStops, a) => {
                    const azRad = Cesium.Math.toRadians(azimuthsDeg[a]);
                    rayStops.forEach((stop, k) => {
                        if (stop.blockIndex < 0) return;
                        const key = `${fanKey}|${a}|${stop.blockIndex}`;
                        if (blockedPoints.has(key)) return;
                        // Same end point the beam mesh uses for this ray, so the dot
                        // sits exactly on the beam's edge instead of on re-clamped terrain.
                        const d = stop.horizontalDistance;
                        const tanEl = Math.tan(Cesium.Math.toRadians(zone.rayElevationsDeg[k]));
                        const local = new Cesium.Cartesian3(Math.sin(azRad) * d, Math.cos(azRad) * d, d * tanEl);
                        blockedPoints.set(key, {
                            position: Cesium.Matrix4.multiplyByPoint(enuMatrix, local, new Cesium.Cartesian3()),
                            color: zone.color
                        });
                    });
                });
            }

            const radarPrimitive = CesiumRadarCoverage.buildRadarVolumePrimitive(
                viewer,
                radarPosition,
                enuMatrix,
                zone,
                azimuthsDeg,
                stops,
                entityId
            );

            if (radarPrimitive) {
                handles.push({ dispose: () => viewer.scene.primitives.remove(radarPrimitive) });
            }

            groundJobs.push({ zone, profiles });
        }

        // Largest zone first, so the smaller zones are layered on top of it.
        groundJobs.sort((p, q) => q.zone.range - p.zone.range);
        const rasters = new Map<string, GroundRaster>();
        for (const job of groundJobs) {
            try {
                const layer = await CesiumRadarCoverage.buildGroundLayer(
                    viewer, cartographic, job.zone, job.profiles, radarHeight
                );
                if (layer) {
                    handles.push(layer.handle);
                    rasters.set(job.zone.name, layer.raster);
                }
            } catch (err) {
                console.error(`Failed to paint ground coverage for ${job.zone.name}:`, err);
            }
        }

        const beams: ZoneBeam[] = [...groundJobs]
            .sort((p, q) => p.zone.range - q.zone.range)
            .map(({ zone, profiles }) => {
                const sweep = Cesium.Math.clamp(zone.azimuthWidthDeg, 1, 360);
                const azStepDeg = sweep / (sweep >= 360 ? profiles.length : Math.max(1, profiles.length - 1));
                return { zone, profiles, azStepDeg, shadowTan: [] };
            });

        const analysis: RadarAnalysis = {
            radarPosition, enuMatrix, radarHeight, terrainProvider, zones, beams, rasters
        };
        CesiumRadarCoverage.analyses.set(entityId, analysis);
        handles.push({
            // A rebuild registers its analysis before the old handles are
            // disposed, so only drop the entry if it is still this build's.
            dispose: () => {
                if (CesiumRadarCoverage.analyses.get(entityId) === analysis) {
                    CesiumRadarCoverage.analyses.delete(entityId);
                }
            }
        });

        if (blockedPoints.size > 0) {
            // Fixed world positions at each blocked ray's end point. Clamping them to
            // terrain made them slide against the beam whenever the camera moved.
            // Depth-tested beyond BLOCKED_POINT_ALWAYS_VISIBLE_M so ridges in front
            // hide them; closer than that the slope they sit on would hide them.
            const pointEntities: Cesium.Entity[] = [];
            viewer.entities.suspendEvents();
            for (const { position, color } of blockedPoints.values()) {
                const pointEntity = viewer.entities.add({
                    position,
                    point: {
                        pixelSize: 8,
                        color,
                        outlineColor: Cesium.Color.WHITE,
                        outlineWidth: 2,
                        heightReference: Cesium.HeightReference.NONE,
                        disableDepthTestDistance: BLOCKED_POINT_ALWAYS_VISIBLE_M
                    }
                });
                (pointEntity as any).radarParentId = entityId;
                pointEntities.push(pointEntity);
            }
            viewer.entities.resumeEvents();
            handles.push({
                dispose: () => {
                    viewer.entities.suspendEvents();
                    for (const e of pointEntities) viewer.entities.remove(e);
                    viewer.entities.resumeEvents();
                }
            });
        }

        viewer.scene.requestRender();
        return handles;
    }

    // -------------------------------------------------------------------
    // 1b. Click Explanation: explainPoint
    // -------------------------------------------------------------------
    // Says whether the radar sees the ground at a clicked spot, why not, and
    // how much of the air above the spot the beam covers. The terrain is
    // sampled afresh along the exact line from the radar to the spot (every
    // 1-5 m), so the blocking crest is found exactly on that line. Returns
    // null when this radar has no finished build.
    // With airHit set, target is a point in the air inside the beam (from
    // findBeamEntry): the label then reports that point first and the ground
    // straight below it second.
    static async explainPoint(
        entityId: string,
        target: Cesium.Cartesian3,
        airHit?: BeamHit
    ): Promise<CoverageExplanation | null> {
        const analysis = CesiumRadarCoverage.analyses.get(entityId);
        if (!analysis) return null;

        const { radarPosition, enuMatrix, radarHeight, terrainProvider, zones, rasters } = analysis;

        const toLocal = Cesium.Matrix4.inverseTransformation(enuMatrix, new Cesium.Matrix4());
        const local = Cesium.Matrix4.multiplyByPoint(toLocal, target, new Cesium.Cartesian3());
        const distanceM = Math.max(1, Math.hypot(local.x, local.y));
        const azRad = Math.atan2(local.x, local.y);
        const bearingDeg = (Cesium.Math.toDegrees(azRad) + 360) % 360;

        // Terrain profile along the exact radar-to-spot line, ending on the spot,
        // at the same spacing as the profiles the shading was built from.
        const spacing = TERRAIN_SAMPLE_SPACING_M;
        const n = Math.max(2, Math.ceil(distanceM / spacing) + 1);
        const dists: number[] = [];
        const cartographics: Cesium.Cartographic[] = [];
        const scratch = new Cesium.Cartesian3();
        for (let i = 0; i < n; i++) {
            const d = i === n - 1 ? distanceM : i * spacing;
            dists.push(d);
            if (i === n - 1) {
                cartographics.push(Cesium.Cartographic.fromCartesian(target));
            } else {
                scratch.x = Math.sin(azRad) * d;
                scratch.y = Math.cos(azRad) * d;
                scratch.z = 0;
                const world = Cesium.Matrix4.multiplyByPoint(enuMatrix, scratch, new Cesium.Cartesian3());
                cartographics.push(Cesium.Cartographic.fromCartesian(world));
            }
        }
        const sampled = await Cesium.sampleTerrainMostDetailed(terrainProvider, cartographics);
        const heights = sampled.map(c => c.height ?? 0);

        // The horizon seen from the radar along this line: the terrain with the
        // highest elevation angle before the spot.
        let shadowTan = -Infinity;
        let crest = -1;
        for (let i = 1; i < n - 1; i++) {
            if (dists[i] < NEAR_FIELD_IGNORE_M) continue;
            const t = CesiumRadarCoverage.sightTan(dists[i], heights[i], radarHeight);
            if (t > shadowTan) {
                shadowTan = t;
                crest = i;
            }
        }

        const groundHeight = heights[n - 1];
        const t = CesiumRadarCoverage.sightTan(distanceM, groundHeight, radarHeight);
        const elevationDeg = Cesium.Math.toDegrees(Math.atan(t));
        // Height of the flat-frame ground at the spot, as the rays see it.
        const flatGround = groundHeight - (distanceM * distanceM) / (2 * EARTH_RADIUS_M);

        // Whether the painted coverage image of a zone shows this spot as seen.
        const targetCartographic = Cesium.Cartographic.fromCartesian(target);
        const paintedSeen = (zone: ResolvedZone): boolean | undefined => {
            const raster = rasters.get(zone.name);
            if (!raster) return undefined;
            const px = Math.floor((targetCartographic.longitude - raster.west) / raster.dLonPx);
            const py = Math.floor((raster.north - targetCartographic.latitude) / raster.dLatPx);
            if (px < 0 || py < 0 || px >= raster.size || py >= raster.size) return false;
            return raster.seen[py * raster.size + px] === 1;
        };

        interface ZoneResult {
            zone: ResolvedZone;
            status: number;
            // What the map shows for this zone at the spot.
            seen: boolean;
            minEl: number;
            maxEl: number;
            airBottom: number;
            airTop: number;
        }

        const inZones: ZoneResult[] = [];
        let outsideSector = false;

        for (const zone of zones) {
            if (zone.azimuthWidthDeg < 360) {
                const offset = (bearingDeg - zone.azimuthStartDeg + 360) % 360;
                if (offset > zone.azimuthWidthDeg) {
                    outsideSector = true;
                    continue;
                }
            }
            if (distanceM > zone.range) continue;

            const minEl = zone.rayElevationsDeg[0];
            const maxEl = zone.rayElevationsDeg[zone.rayElevationsDeg.length - 1];
            const minTan = Math.tan(Cesium.Math.toRadians(minEl));
            const maxTan = Math.tan(Cesium.Math.toRadians(maxEl));

            let status: number;
            if (distanceM * Math.sqrt(1 + t * t) > zone.range) status = GROUND_OUT_OF_RANGE;
            else if (t < minTan) status = GROUND_BELOW_BEAM;
            else if ((shadowTan - t) * distanceM > GRAZE_TOLERANCE_M) status = GROUND_BLOCKED;
            else if (t > maxTan) status = GROUND_ABOVE_BEAM;
            else status = GROUND_COVERED;

            // Air the beam fills straight above the spot: from the lowest ray that
            // clears the horizon up to the top ray, capped by the slant range.
            const lowTan = Math.max(minTan, shadowTan);
            const slantCap = Math.sqrt(Math.max(0, zone.range * zone.range - distanceM * distanceM));
            const airBottom = radarHeight + distanceM * lowTan - flatGround;
            const airTop = radarHeight + Math.min(distanceM * maxTan, slantCap) - flatGround;

            const seen = paintedSeen(zone) ?? status === GROUND_COVERED;
            inZones.push({ zone, status, seen, minEl, maxEl, airBottom, airTop });
        }

        const spot = `This spot: ${formatDistance(distanceM)} from the radar, bearing ${bearingDeg.toFixed(0)}°`;
        const lines: string[] = [];
        let blocker: CoverageBlocker | undefined;

        if (inZones.length === 0) {
            const maxRange = Math.max(...zones.map(z => z.range), 0);
            lines.push(
                outsideSector && distanceM <= maxRange
                    ? "OUTSIDE RADAR SECTOR - the radar does not look this way"
                    : `OUT OF RANGE - beyond every zone (max ${formatDistance(maxRange)})`,
                spot
            );
            return { radarPosition, targetPosition: target, visible: false, lines, blocker };
        }

        // Visible exactly when the map shows the spot shaded, so the label never
        // contradicts the picture. The exact line profile then gives the reason.
        const covering = inZones.filter(z => z.seen);
        const visible = covering.length > 0;

        if (visible) {
            lines.push(
                "VISIBLE - the radar sees the ground here",
                `Seen by ${covering.map(z => z.zone.name).join(", ")}`
            );
            if (covering.every(z => z.status !== GROUND_COVERED)) {
                lines.push("(right at the edge of a shadow - only just reached)");
            }
        } else {
            // The zone that tilts highest decides: if even it misses the spot,
            // its reason is the real one.
            const main = [...inZones].sort((p, q) => q.maxEl - p.maxEl || q.zone.range - p.zone.range)[0];

            switch (main.status) {
                case GROUND_BLOCKED: {
                    const crestDist = dists[crest];
                    blocker = {
                        position: Cesium.Cartesian3.fromRadians(
                            cartographics[crest].longitude,
                            cartographics[crest].latitude,
                            heights[crest]
                        ),
                        distanceM: crestDist,
                        groundHeightM: heights[crest]
                    };
                    if (distanceM - crestDist <= OWN_SLOPE_BLOCKER_M) {
                        lines.push(
                            "NOT VISIBLE - the ground slopes away from the radar",
                            "The rays skim over the edge just in front of this spot"
                        );
                    } else {
                        lines.push(
                            "NOT VISIBLE - a mountain is in the way",
                            `Mountain ${formatDistance(crestDist)} from the radar hides this spot`,
                            `(mountain top ${heights[crest].toFixed(0)} m, radar at ${radarHeight.toFixed(0)} m)`
                        );
                    }
                    break;
                }
                case GROUND_ABOVE_BEAM:
                    lines.push(
                        "NOT VISIBLE - too high for the beam",
                        `This spot is ${elevationDeg.toFixed(1)}° up; the beam only reaches ${main.maxEl.toFixed(0)}°`
                    );
                    break;
                case GROUND_BELOW_BEAM:
                    lines.push(
                        "NOT VISIBLE - the ground is below the beam",
                        `Ground is ${Math.abs(elevationDeg).toFixed(1)}° ${elevationDeg < 0 ? "below" : "above"} ` +
                        `the radar, under the lowest ray (${main.minEl.toFixed(0)}°)`
                    );
                    break;
                case GROUND_COVERED:
                    // The exact line just reaches the spot, but the patch is too thin
                    // to show at the map's shading resolution.
                    lines.push(
                        "NOT VISIBLE - right at the edge of the coverage",
                        "Only a sliver here is reached, too thin to shade on the map"
                    );
                    break;
                default:
                    lines.push("NOT VISIBLE - just past the range limit");
            }
        }

        // Air coverage above the spot, over every zone that reaches it.
        const air = inZones.filter(z => z.airTop > Math.max(0, z.airBottom));
        if (air.length > 0) {
            const bottom = Math.max(0, Math.min(...air.map(z => z.airBottom)));
            const top = Math.max(...air.map(z => z.airTop));
            lines.push(
                bottom < 1
                    ? `The radar beam covers the air here from the ground up to ${top.toFixed(0)} m`
                    : `The radar beam passes ${bottom.toFixed(0)} m above this spot (covers up to ${top.toFixed(0)} m)`
            );
            if (!visible) {
                // Seen from above, the translucent 3D beam tints the ground under
                // it, which reads like ground coverage unless we say so.
                lines.push("The colour over this spot is the beam in the AIR, not on the ground");
            }
        } else {
            lines.push("No radar beam in the air above this spot");
        }

        const innermost = [...inZones].sort((p, q) => p.zone.range - q.zone.range)[0];
        lines.push(`${spot}, in ${innermost.zone.name}`);

        if (airHit) {
            const cartographic = Cesium.Cartographic.fromCartesian(target);
            const aboveGround = cartographic.height - groundHeight;
            const beamLine = air.length > 0
                ? `Beam here: from ${Math.max(0, Math.min(...air.map(z => z.airBottom))).toFixed(0)} m ` +
                  `up to ${Math.max(...air.map(z => z.airTop)).toFixed(0)} m above the ground`
                : undefined;
            return {
                radarPosition,
                targetPosition: target,
                groundPosition: Cesium.Cartesian3.fromRadians(
                    cartographic.longitude, cartographic.latitude, groundHeight
                ),
                visible: true,
                lines: [
                    "IN RADAR COVERAGE - this point in the air is inside the beam",
                    `This point: ${aboveGround.toFixed(0)} m above the ground, in ${airHit.zoneName}`,
                    ...(beamLine ? [beamLine] : []),
                    `Ground below: ${lines[0]}`,
                    spot
                ]
            };
        }

        return { radarPosition, targetPosition: target, visible, lines, blocker };
    }

    // -------------------------------------------------------------------
    // 1c. Beam Hit Test: findBeamEntry
    // -------------------------------------------------------------------
    // Walks the camera ray of a click from `from` to `to` (normally the terrain
    // it hits) and returns the first point inside one of this radar's drawn
    // beams, refined by bisection. A point is inside when it is within a
    // zone's sector, slant range and elevation band, and the ray from the
    // radar at that elevation is not stopped by terrain before it - the same
    // rules the beam mesh was built with.
    static findBeamEntry(entityId: string, from: Cesium.Cartesian3, to: Cesium.Cartesian3): BeamHit | undefined {
        const analysis = CesiumRadarCoverage.analyses.get(entityId);
        if (!analysis || analysis.beams.length === 0) return undefined;

        const toLocal = Cesium.Matrix4.inverseTransformation(analysis.enuMatrix, new Cesium.Matrix4());
        const a = Cesium.Matrix4.multiplyByPoint(toLocal, from, new Cesium.Cartesian3());
        const b = Cesium.Matrix4.multiplyByPoint(toLocal, to, new Cesium.Cartesian3());
        const len = Cesium.Cartesian3.distance(a, b);
        const p = new Cesium.Cartesian3();
        const at = (t: number): Cesium.Cartesian3 => Cesium.Cartesian3.lerp(a, b, t, p);

        const steps = Math.min(20000, Math.max(200, Math.ceil(len / 5)));
        let prev = 0;
        for (let s = 1; s <= steps; s++) {
            const t = s / steps;
            if (!CesiumRadarCoverage.zoneAtLocal(analysis, at(t))) {
                prev = t;
                continue;
            }
            // Bisect the crossing between the last outside and first inside sample.
            let lo = prev;
            let hi = t;
            for (let k = 0; k < 30; k++) {
                const mid = (lo + hi) / 2;
                if (CesiumRadarCoverage.zoneAtLocal(analysis, at(mid))) hi = mid;
                else lo = mid;
            }
            const zoneName = CesiumRadarCoverage.zoneAtLocal(analysis, at(hi))!;
            return {
                position: Cesium.Matrix4.multiplyByPoint(analysis.enuMatrix, at(hi), new Cesium.Cartesian3()),
                zoneName
            };
        }
        return undefined;
    }

    // Name of the innermost zone whose beam contains a point given in the
    // radar's local east-north-up frame, or undefined.
    private static zoneAtLocal(analysis: RadarAnalysis, local: Cesium.Cartesian3): string | undefined {
        const d = Math.hypot(local.x, local.y);
        if (d < 1) return undefined;
        const tanEl = local.z / d;
        const slant = Math.hypot(d, local.z);
        const bearingDeg = Cesium.Math.toDegrees(Math.atan2(local.x, local.y));

        for (const beam of analysis.beams) {
            const { zone, profiles, azStepDeg } = beam;
            if (slant > zone.range) continue;

            const minTan = Math.tan(Cesium.Math.toRadians(zone.rayElevationsDeg[0]));
            const maxTan = Math.tan(Cesium.Math.toRadians(zone.rayElevationsDeg[zone.rayElevationsDeg.length - 1]));
            if (tanEl < minTan || tanEl > maxTan) continue;

            const fullCircle = zone.azimuthWidthDeg >= 360;
            const offset = ((bearingDeg - zone.azimuthStartDeg) % 360 + 360) % 360;
            if (!fullCircle && offset > zone.azimuthWidthDeg) continue;
            const a = fullCircle
                ? Math.round(offset / azStepDeg) % profiles.length
                : Math.min(profiles.length - 1, Math.round(offset / azStepDeg));

            let shadow = beam.shadowTan[a];
            if (!shadow) {
                const { horizontalDistances, groundHeights } = profiles[a];
                shadow = new Float64Array(horizontalDistances.length).fill(-Infinity);
                for (let i = 1; i < shadow.length; i++) {
                    const t = horizontalDistances[i] < NEAR_FIELD_IGNORE_M
                        ? -Infinity
                        : CesiumRadarCoverage.sightTan(horizontalDistances[i], groundHeights[i], analysis.radarHeight);
                    shadow[i] = Math.max(shadow[i - 1], t);
                }
                beam.shadowTan[a] = shadow;
            }

            const dists = profiles[a].horizontalDistances;
            const spacing = dists[1] - dists[0];
            const i = Math.min(shadow.length - 1, Math.floor(d / spacing));
            if ((shadow[i] - tanEl) * d > GRAZE_TOLERANCE_M) continue;

            return zone.name;
        }
        return undefined;
    }

    // Tangent of the elevation angle from the radar to a ground point, in the
    // same flat local frame (ground lowered by d^2/2R) that traceRay uses.
    private static sightTan(dist: number, groundHeight: number, radarHeight: number): number {
        const curvatureDrop = (dist * dist) / (2 * EARTH_RADIUS_M);
        return (groundHeight - curvatureDrop - radarHeight) / Math.max(dist, 1);
    }

    // Classifies the first n terrain samples of one azimuth into out[offset..]:
    // covered when a ray of the zone lands on it, otherwise why not. Same rules
    // as explainPoint.
    private static classifyColumn(
        dists: ArrayLike<number>,
        heights: ArrayLike<number>,
        n: number,
        radarHeight: number,
        zone: ResolvedZone,
        out: Uint8Array,
        offset: number
    ): void {
        const minTan = Math.tan(Cesium.Math.toRadians(zone.rayElevationsDeg[0]));
        const maxTan = Math.tan(Cesium.Math.toRadians(zone.rayElevationsDeg[zone.rayElevationsDeg.length - 1]));
        let shadowTan = -Infinity;

        for (let i = 1; i < n; i++) {
            const d = dists[i];
            const t = CesiumRadarCoverage.sightTan(d, heights[i], radarHeight);
            let status: number;

            if (d * Math.sqrt(1 + t * t) > zone.range) status = GROUND_OUT_OF_RANGE;
            else if (t < minTan) status = GROUND_BELOW_BEAM; // no ray points this low
            else if ((shadowTan - t) * d > GRAZE_TOLERANCE_M) status = GROUND_BLOCKED;  // nearer terrain is in the way
            else if (t > maxTan) status = GROUND_ABOVE_BEAM;
            else status = GROUND_COVERED;

            out[offset + i] = status;
            if (t > shadowTan && d >= NEAR_FIELD_IGNORE_M) shadowTan = t;
        }
        out[offset] = n > 1 ? out[offset + 1] : GROUND_COVERED;
    }

    // -------------------------------------------------------------------
    // 2. Helper Azimuth List Generator: buildAzimuthList
    // -------------------------------------------------------------------
    private static buildAzimuthList(
        sectorStartDeg: number,
        sectorSweepDeg: number,
        stepDeg: number
    ): number[] {
        const sweep = Cesium.Math.clamp(sectorSweepDeg, 1, 360);
        const step = Math.max(1, stepDeg);
        const count = Math.max(2, Math.round(sweep / step) + (sweep >= 360 ? 0 : 1));
        const azimuths: number[] = [];

        for (let i = 0; i < count; i++) {
            const raw = sectorStartDeg + (sweep * i) / (sweep >= 360 ? count : count - 1);
            azimuths.push(((raw % 360) + 360) % 360);
        }
        return azimuths;
    }

    // -------------------------------------------------------------------
    // 3. Terrain Profiles Builder: buildTerrainProfiles
    // -------------------------------------------------------------------
    private static async buildTerrainProfiles(
        terrainProvider: Cesium.TerrainProvider,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthsDeg: number[],
        maxRange: number,
        spacing: number
    ): Promise<TerrainProfile[]> {
        const sampleCount = Math.max(2, Math.ceil(maxRange / spacing)) + 1;
        const horizontalDistances: number[] = [];
        for (let i = 0; i < sampleCount; i++) {
            horizontalDistances.push(Math.min(i * spacing, maxRange));
        }

        const flatCartographics: Cesium.Cartographic[] = [];
        const scratchPoint = new Cesium.Cartesian3();

        for (const azimuthDeg of azimuthsDeg) {
            const groundRay = CesiumRadarCoverage.makeRay(radarPosition, enuMatrix, azimuthDeg, 0);
            for (const distance of horizontalDistances) {
                const point = Cesium.Ray.getPoint(groundRay, distance, scratchPoint);
                flatCartographics.push(Cesium.Cartographic.fromCartesian(point));
            }
        }

        const sampledTerrain = await Cesium.sampleTerrainMostDetailed(terrainProvider, flatCartographics);

        return azimuthsDeg.map((azimuthDeg, a) => {
            const groundHeights: number[] = [];
            const base = a * sampleCount;
            for (let i = 0; i < sampleCount; i++) {
                groundHeights.push(sampledTerrain[base + i].height ?? 0);
            }
            const groundPoints = sampledTerrain.slice(base, base + sampleCount);
            return { azimuthDeg, horizontalDistances, groundHeights, groundPoints };
        });
    }

    // -------------------------------------------------------------------
    // 4. Helper Ray Generator: makeRay (used by buildTerrainProfiles)
    // -------------------------------------------------------------------
    private static makeRay(
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        azimuthDeg: number,
        elevationDeg: number
    ): Cesium.Ray {
        const azimuth = Cesium.Math.toRadians(azimuthDeg);
        const elevation = Cesium.Math.toRadians(elevationDeg);

        const localDirection = new Cesium.Cartesian3(
            Math.sin(azimuth) * Math.cos(elevation),
            Math.cos(azimuth) * Math.cos(elevation),
            Math.sin(elevation)
        );

        const worldDirection = Cesium.Matrix4.multiplyByPointAsVector(
            enuMatrix,
            localDirection,
            new Cesium.Cartesian3()
        );

        Cesium.Cartesian3.normalize(worldDirection, worldDirection);
        return new Cesium.Ray(radarPosition, worldDirection);
    }

    // -------------------------------------------------------------------
    // 5. Single-Ray Line-of-Sight Trace: traceRay
    // -------------------------------------------------------------------
    // Walks one straight ray outward and returns where it first goes below the
    // ground, or where it reaches the zone's slant range if nothing is in the way.
    private static traceRay(
        profile: TerrainProfile,
        radarHeight: number,
        slantRange: number,
        elevationDeg: number
    ): RayStop {
        const { horizontalDistances, groundHeights } = profile;
        const elevationRad = Cesium.Math.toRadians(elevationDeg);
        const tanEl = Math.tan(elevationRad);
        const maxHorizontal = slantRange * Math.cos(elevationRad);

        // Height of the ray above the ground at sample i. The ray is a straight line
        // in the radar's local tangent frame, while the Earth curves away beneath it
        // by ~d^2/2R, so the ground is lowered by that much to match the drawn volume.
        const clearance = (i: number): number => {
            const dist = horizontalDistances[i];
            const curvatureDrop = (dist * dist) / (2 * EARTH_RADIUS_M);
            return radarHeight + dist * tanEl - (groundHeights[i] - curvatureDrop);
        };

        let prevClearance = clearance(0);

        for (let i = 1; i < horizontalDistances.length; i++) {
            const dist = horizontalDistances[i];
            if (dist > maxHorizontal) break;

            const currClearance = clearance(i);

            if (dist < NEAR_FIELD_IGNORE_M) {
                prevClearance = Math.max(0, currClearance);
                continue;
            }

            if (currClearance < -GRAZE_TOLERANCE_M) {
                // The ray went under the ground between samples i-1 and i. Interpolate
                // the exact crossing so the ray ends on the terrain surface rather
                // than up to one sample spacing inside the hill.
                const prevDist = horizontalDistances[i - 1];
                const t = prevClearance > 0
                    ? prevClearance / (prevClearance - currClearance)
                    : 0;
                return {
                    horizontalDistance: prevDist + t * (dist - prevDist),
                    blockIndex: i
                };
            }

            prevClearance = currClearance;
        }
        return { horizontalDistance: maxHorizontal, blockIndex: -1 };
    }

    // -------------------------------------------------------------------
    // 6. Volumetric Mesh Primitive Builder: buildRadarVolumePrimitive
    // -------------------------------------------------------------------
    // The outer surface joins every ray's end point to its neighbours (next
    // azimuth, next elevation). The highest rays are closed back to the radar
    // with a fan, and so are the two sector edges when the sweep is < 360. There
    // is no floor fan, so no footprint is drawn on the ground.
    private static buildRadarVolumePrimitive(
        viewer: Cesium.Viewer,
        radarPosition: Cesium.Cartesian3,
        enuMatrix: Cesium.Matrix4,
        zone: ResolvedZone,
        azimuthsDeg: number[],
        stops: RayStop[][],
        entityId: string
    ): Cesium.Primitive | null {
        const numAzimuths = azimuthsDeg.length;
        const numRays = zone.rayElevationsDeg.length;
        if (numAzimuths < 2 || numRays < 1) return null;

        const fullCircle = zone.azimuthWidthDeg >= 360;
        const positions: number[] = [];
        const ranges: number[] = [];
        const indices: number[] = [];
        const boundingPoints: Cesium.Cartesian3[] = [radarPosition];

        const apexIdx = 0;
        positions.push(radarPosition.x, radarPosition.y, radarPosition.z);
        ranges.push(0);

        const tanEls = zone.rayElevationsDeg.map(el => Math.tan(Cesium.Math.toRadians(el)));
        const scratchLocal = new Cesium.Cartesian3();

        for (let a = 0; a < numAzimuths; a++) {
            const azRad = Cesium.Math.toRadians(azimuthsDeg[a]);
            const sinAz = Math.sin(azRad);
            const cosAz = Math.cos(azRad);

            for (let k = 0; k < numRays; k++) {
                const d = stops[a][k].horizontalDistance;
                scratchLocal.x = sinAz * d;
                scratchLocal.y = cosAz * d;
                scratchLocal.z = d * tanEls[k];
                const world = Cesium.Matrix4.multiplyByPoint(enuMatrix, scratchLocal, new Cesium.Cartesian3());
                positions.push(world.x, world.y, world.z);
                ranges.push(d);
                boundingPoints.push(world);
            }
        }

        const v = (a: number, k: number) => 1 + a * numRays + k;
        // A full circle also joins the last azimuth back to the first.
        const columnPairs = fullCircle ? numAzimuths : numAzimuths - 1;

        for (let a = 0; a < columnPairs; a++) {
            const a2 = (a + 1) % numAzimuths;

            // Outer surface between neighbouring ray end points. A panel whose
            // corners all landed on the same hillside lies along the terrain,
            // where the rendered terrain cuts it into patches; the draped ground
            // shading shows that area instead. Panels whose corners landed far
            // apart (across a valley) are in the air and stay.
            for (let k = 0; k < numRays - 1; k++) {
                if (CesiumRadarCoverage.liesOnTerrain(
                    [stops[a][k], stops[a2][k], stops[a2][k + 1], stops[a][k + 1]]
                )) continue;
                indices.push(v(a, k), v(a2, k), v(a2, k + 1));
                indices.push(v(a, k), v(a2, k + 1), v(a, k + 1));
            }

            // Highest rays back to the radar. The lowest rays are not closed back:
            // that floor lay along the ground and drew a blotchy footprint wherever
            // the terrain cut through it.
            indices.push(apexIdx, v(a2, numRays - 1), v(a, numRays - 1));
        }

        if (!fullCircle) {
            for (const a of [0, numAzimuths - 1]) {
                for (let k = 0; k < numRays - 1; k++) {
                    indices.push(apexIdx, v(a, k), v(a, k + 1));
                }
            }
        }

        const geometry = new Cesium.Geometry({
            attributes: ({
                position: new Cesium.GeometryAttribute({
                    componentDatatype: Cesium.ComponentDatatype.DOUBLE,
                    componentsPerAttribute: 3,
                    values: new Float64Array(positions)
                }),
                // Read by the beam vertex shader to size its depth pull.
                rangeFromRadar: new Cesium.GeometryAttribute({
                    componentDatatype: Cesium.ComponentDatatype.FLOAT,
                    componentsPerAttribute: 1,
                    values: new Float32Array(ranges)
                })
            } as unknown) as Cesium.GeometryAttributes,
            indices: new Uint32Array(indices),
            boundingSphere: Cesium.BoundingSphere.fromPoints(boundingPoints)
        });

        // Panel width per metre of range is the azimuth step in radians.
        const azimuthStepRad = Cesium.Math.toRadians(
            Math.min(zone.azimuthWidthDeg, 360) / Math.max(1, fullCircle ? numAzimuths : numAzimuths - 1)
        );
        const pullPerRangeM = azimuthStepRad * BEAM_DEPTH_PULL_PER_PANEL_WIDTH;

        const primitive = new Cesium.Primitive({
            geometryInstances: new Cesium.GeometryInstance({
                geometry: geometry,
                id: entityId,
                attributes: {
                    color: Cesium.ColorGeometryInstanceAttribute.fromColor(zone.color.withAlpha(zone.beamOpacity))
                }
            }),
            // closed: false disables back-face culling. With it on, faces vanished
            // whenever the camera zoomed close to or inside the volume.
            // Depth test on so the terrain in front hides the beam. With it off the
            // beam was painted over the terrain and appeared to float and slide
            // across the hills whenever the camera moved.
            // Flat (unlit) so every panel has the same shade, and the vertex shader
            // pulls depth toward the camera so panels lying on the hillside are not
            // cut into patches by the terrain between two ray end points.
            appearance: new Cesium.PerInstanceColorAppearance({
                translucent: true,
                closed: false,
                flat: true,
                vertexShaderSource: buildBeamVS(pullPerRangeM),
                fragmentShaderSource: BEAM_FS,
                renderState: {
                    depthTest: { enabled: true },
                    depthMask: false
                }
            }),
            asynchronous: false
        });

        viewer.scene.primitives.add(primitive);
        return primitive;
    }

    private static liesOnTerrain(corners: RayStop[]): boolean {
        if (corners.some(c => c.blockIndex < 0)) return false;
        const ds = corners.map(c => c.horizontalDistance);
        const maxD = Math.max(...ds);
        return maxD - Math.min(...ds) < Math.max(50, 0.1 * maxD);
    }

    // -------------------------------------------------------------------
    // 7. Terrain-Painted Ground Coverage: buildGroundLayer
    // -------------------------------------------------------------------
    // Proper terrain masking painted onto the terrain. Every terrain sample of
    // every traced azimuth is classified (does a ray of this zone land here?),
    // with GROUND_SUBDIVISIONS columns interpolated between neighbouring
    // azimuths. The result is drawn into an image - see-through fill where the
    // ground is seen, a solid outline around each seen patch and a ring at the
    // zone's range - and added as an imagery layer, which the globe drapes
    // onto the terrain exactly at every zoom level.
    private static async buildGroundLayer(
        viewer: Cesium.Viewer,
        radarCartographic: Cesium.Cartographic,
        zone: ResolvedZone,
        profiles: TerrainProfile[],
        radarHeight: number
    ): Promise<{ handle: RadarCoverageHandle; raster: GroundRaster } | null> {
        const numAz = profiles.length;
        if (numAz < 2) return null;

        const fullCircle = zone.azimuthWidthDeg >= 360;
        const sweep = Cesium.Math.clamp(zone.azimuthWidthDeg, 1, 360);
        const azStep = sweep / (fullCircle ? numAz : numAz - 1);
        const numColumns = fullCircle ? numAz * GROUND_SUBDIVISIONS : (numAz - 1) * GROUND_SUBDIVISIONS + 1;
        const columnStep = azStep / GROUND_SUBDIVISIONS;
        const dists = profiles[0].horizontalDistances;
        const spacing = dists[1] - dists[0];
        const sampleCount = Math.min(dists.length, Math.ceil(zone.range / spacing) + 2);

        // status[c * sampleCount + i]: ground status of sample i in column c.
        const status = new Uint8Array(numColumns * sampleCount);
        const heights = new Float64Array(sampleCount);
        for (let c = 0; c < numColumns; c++) {
            const a0 = Math.floor(c / GROUND_SUBDIVISIONS);
            const a1 = fullCircle ? (a0 + 1) % numAz : Math.min(a0 + 1, numAz - 1);
            const w = (c % GROUND_SUBDIVISIONS) / GROUND_SUBDIVISIONS;
            const h0 = profiles[a0].groundHeights;
            const h1 = profiles[a1].groundHeights;
            for (let i = 0; i < sampleCount; i++) heights[i] = h0[i] + (h1[i] - h0[i]) * w;
            CesiumRadarCoverage.classifyColumn(dists, heights, sampleCount, radarHeight, zone, status, c * sampleCount);
        }

        // Image over the zone's bounding rectangle. Pixels map linearly to
        // lon/lat; metres use the ellipsoid's local radii, per row.
        const lat0 = radarCartographic.latitude;
        const lon0 = radarCartographic.longitude;
        const e2 = Cesium.Ellipsoid.WGS84.radii.x ** 2 - Cesium.Ellipsoid.WGS84.radii.z ** 2;
        const a2 = Cesium.Ellipsoid.WGS84.radii.x ** 2;
        const ecc2 = e2 / a2;
        const sin0 = Math.sin(lat0);
        const w0 = 1 - ecc2 * sin0 * sin0;
        const meridianRadius = Cesium.Ellipsoid.WGS84.radii.x * (1 - ecc2) / Math.pow(w0, 1.5);
        const normalRadius = Cesium.Ellipsoid.WGS84.radii.x / Math.sqrt(w0);

        const halfLat = zone.range / meridianRadius * 1.01;
        const halfLon = zone.range / (normalRadius * Math.cos(Math.abs(lat0) + halfLat)) * 1.01;
        const size = Math.round(Cesium.Math.clamp(
            (2 * zone.range) / GROUND_TEXTURE_MIN_M_PER_PX, 256, GROUND_TEXTURE_MAX_PX
        ));
        const metresPerPx = (2 * zone.range) / size;
        const dLatPx = (2 * halfLat) / size;
        const dLonPx = (2 * halfLon) / size;
        const north = lat0 + halfLat;
        const west = lon0 - halfLon;

        // Per pixel: distance from the radar (or -1 outside the zone's sector) and
        // whether the ground there is seen.
        const pixelDist = new Float32Array(size * size).fill(-1);
        const seen = new Uint8Array(size * size);

        for (let py = 0; py < size; py++) {
            const lat = north - (py + 0.5) * dLatPx;
            const y = (lat - lat0) * meridianRadius;
            const xScale = normalRadius * Math.cos(lat);
            for (let px = 0; px < size; px++) {
                const x = (west + (px + 0.5) * dLonPx - lon0) * xScale;
                const d = Math.hypot(x, y);
                if (d > zone.range + 2 * metresPerPx) continue;

                const offset = ((Cesium.Math.toDegrees(Math.atan2(x, y)) - zone.azimuthStartDeg) % 360 + 360) % 360;
                let c: number;
                if (fullCircle) {
                    c = Math.round(offset / columnStep) % numColumns;
                } else {
                    if (offset > sweep) continue;
                    c = Math.min(numColumns - 1, Math.round(offset / columnStep));
                }

                const k = py * size + px;
                pixelDist[k] = d;
                const i = Math.round(d / spacing);
                if (i < sampleCount && status[c * sampleCount + i] === GROUND_COVERED) seen[k] = 1;
            }
        }

        // 3x3 majority vote, so single-pixel specks and pinholes go away.
        const clean = new Uint8Array(size * size);
        for (let py = 1; py < size - 1; py++) {
            for (let px = 1; px < size - 1; px++) {
                const k = py * size + px;
                if (pixelDist[k] < 0) continue;
                const votes =
                    seen[k - size - 1] + seen[k - size] + seen[k - size + 1] +
                    seen[k - 1] + seen[k] + seen[k + 1] +
                    seen[k + size - 1] + seen[k + size] + seen[k + size + 1];
                clean[k] = votes >= 5 ? 1 : 0;
            }
        }

        const r = Math.round(zone.color.red * 255);
        const g = Math.round(zone.color.green * 255);
        const b = Math.round(zone.color.blue * 255);
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        if (!ctx) return null;
        const image = ctx.createImageData(size, size);
        const rgba = image.data;

        for (let py = 2; py < size - 2; py++) {
            for (let px = 2; px < size - 2; px++) {
                const k = py * size + px;
                const d = pixelDist[k];
                if (d < 0) continue;

                let alpha = 0;
                if (clean[k]) {
                    // Outline: a seen pixel within 2 px of unseen ground.
                    const edge =
                        !clean[k - 1] || !clean[k + 1] || !clean[k - size] || !clean[k + size] ||
                        !clean[k - 2] || !clean[k + 2] || !clean[k - 2 * size] || !clean[k + 2 * size];
                    alpha = edge ? GROUND_OUTLINE_ALPHA : GROUND_FILL_ALPHA;
                }
                if (Math.abs(d - zone.range) <= metresPerPx) {
                    alpha = Math.max(alpha, GROUND_RANGE_RING_ALPHA);
                }
                if (alpha === 0) continue;

                const o = k * 4;
                rgba[o] = r;
                rgba[o + 1] = g;
                rgba[o + 2] = b;
                rgba[o + 3] = alpha;
            }
        }
        ctx.putImageData(image, 0, 0);

        const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, "image/png"));
        if (!blob) return null;
        const url = URL.createObjectURL(blob);

        try {
            const provider = await Cesium.SingleTileImageryProvider.fromUrl(url, {
                rectangle: Cesium.Rectangle.fromRadians(west, lat0 - halfLat, lon0 + halfLon, north)
            });
            const layer = viewer.imageryLayers.addImageryProvider(provider);
            viewer.scene.requestRender();
            return {
                handle: {
                    dispose: () => {
                        viewer.imageryLayers.remove(layer, true);
                        viewer.scene.requestRender();
                    }
                },
                raster: { seen: clean, size, west, north, dLatPx, dLonPx }
            };
        } finally {
            URL.revokeObjectURL(url);
        }
    }
}
