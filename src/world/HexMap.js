import * as THREE from 'three';
import { buildHexMapData, getHexVertices, isPointInsideHex } from './hexGrid.js';
import { getSectorColor, getSectorInfo } from '../config/mapConfig.js';

function createFloorGeometry(radius) {
  const vertices = getHexVertices(0, 0, radius);
  const positions = [0, 0, 0];
  for (const vertex of vertices) positions.push(vertex.x, 0, vertex.z);

  const indices = [];
  for (let i = 0; i < vertices.length; i += 1) {
    // Reverse the x/z winding so the single flat face points upward (+Y).
    indices.push(0, 1 + ((i + 1) % vertices.length), 1 + i);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function createHexRingGeometry(innerRadius, outerRadius) {
  const innerVerts = getHexVertices(0, 0, innerRadius);
  const outerVerts = getHexVertices(0, 0, outerRadius);
  const positions = [];
  const indices = [];
  for (let i = 0; i < 6; i += 1) {
    positions.push(innerVerts[i].x, 0, innerVerts[i].z);
    positions.push(outerVerts[i].x, 0, outerVerts[i].z);
  }
  for (let i = 0; i < 6; i += 1) {
    const next = (i + 1) % 6;
    const i0 = i * 2;
    const o0 = i * 2 + 1;
    const i1 = next * 2;
    const o1 = next * 2 + 1;
    indices.push(i0, o0, i1);
    indices.push(i1, o0, o1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function makeCanvasLabel(text, colorHex = '#e9f2ee', subtitle = '') {
  const canvas = document.createElement('canvas');
  canvas.width = 768;
  canvas.height = 210;
  const context = canvas.getContext('2d');
  context.fillStyle = 'rgba(18, 24, 26, 0.94)';
  context.beginPath();
  context.roundRect(6, 6, canvas.width - 12, canvas.height - 12, 18);
  context.fill();

  context.strokeStyle = colorHex;
  context.lineWidth = 6;
  context.stroke();

  if (typeof context.fillRect === 'function') {
    context.fillStyle = colorHex;
    context.fillRect(24, 18, canvas.width - 48, 4);
  }

  context.fillStyle = '#ffffff';
  context.font = '700 62px ui-monospace, SFMono-Regular, Consolas, monospace';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(text, canvas.width / 2, canvas.height / 2 - (subtitle ? 16 : 0));

  if (subtitle) {
    context.fillStyle = colorHex;
    context.font = '600 36px ui-sans-serif, system-ui, sans-serif';
    context.fillText(subtitle.toUpperCase(), canvas.width / 2, canvas.height / 2 + 52);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(108, 29.5, 1);
  sprite.renderOrder = 1001;
  return sprite;
}

function axisForEdge(edge) {
  const dx = edge.end.x - edge.start.x;
  const dz = edge.end.z - edge.start.z;
  const length = Math.hypot(dx, dz);
  const axisX = dx / length;
  const axisZ = dz / length;
  return {
    axisX,
    axisZ,
    yaw: -Math.atan2(dz, dx),
    length,
  };
}

function createPortalBezelGeometry(gateWidth, frameWidth, wallHeight) {
  const outerHalf = gateWidth / 2 + frameWidth + 1.4;
  const innerHalf = gateWidth / 2 + 0.42;
  const crownHeight = wallHeight + 1.15;
  const innerTop = wallHeight - 2.1;
  const outerChamfer = 3.2;
  const innerChamfer = 1.6;
  const shape = new THREE.Shape();

  // A single clipped-corner, U-shaped surround creates a solid architectural
  // bezel around the existing structural posts without closing the passage.
  shape.moveTo(-outerHalf, 0);
  shape.lineTo(-outerHalf, crownHeight - outerChamfer);
  shape.lineTo(-outerHalf + outerChamfer, crownHeight);
  shape.lineTo(outerHalf - outerChamfer, crownHeight);
  shape.lineTo(outerHalf, crownHeight - outerChamfer);
  shape.lineTo(outerHalf, 0);
  shape.lineTo(innerHalf, 0);
  shape.lineTo(innerHalf, innerTop - innerChamfer);
  shape.lineTo(innerHalf - innerChamfer, innerTop);
  shape.lineTo(-innerHalf + innerChamfer, innerTop);
  shape.lineTo(-innerHalf, innerTop - innerChamfer);
  shape.lineTo(-innerHalf, 0);
  shape.closePath();

  const depth = 0.9;
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelSegments: 2,
    steps: 1,
    bevelSize: 0.16,
    bevelThickness: 0.14,
    curveSegments: 2,
  });
  geometry.translate(0, 0, -depth / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createPortalLightGeometry(gateWidth, openingHeight) {
  const halfWidth = gateWidth / 2 - 0.85;
  const cornerCut = 1.8;
  const points = [
    new THREE.Vector3(-halfWidth, 0.55, 0),
    new THREE.Vector3(-halfWidth, openingHeight - cornerCut, 0),
    new THREE.Vector3(-halfWidth + cornerCut, openingHeight - 0.35, 0),
    new THREE.Vector3(halfWidth - cornerCut, openingHeight - 0.35, 0),
    new THREE.Vector3(halfWidth, openingHeight - cornerCut, 0),
    new THREE.Vector3(halfWidth, 0.55, 0),
  ];
  const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
  const geometry = new THREE.TubeGeometry(curve, 72, 0.19, 7, false);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

function createPortalCrestGeometry() {
  const geometry = new THREE.CylinderGeometry(1.7, 1.7, 0.62, 6, 1);
  geometry.rotateX(Math.PI / 2);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export class HexMap {
  constructor(scene, config) {
    this.config = config;
    this.data = buildHexMapData(config.hexRadius);
    this.sectors = this.data.sectors;
    this.sectorById = this.data.byId;
    this.gates = this.data.sharedEdges;
    this.boundaryEdges = this.data.boundaryEdges;
    this.bounds = this.data.bounds;
    this.group = new THREE.Group();
    this.group.name = 'HexMap';
    scene.add(this.group);

    this.floorGeometry = createFloorGeometry(config.hexRadius);
    this.floorRingGeometry = createHexRingGeometry(config.hexRadius * 0.88, config.hexRadius * 0.905);
    this.floorCenterGeometry = createFloorGeometry(28);

    this.floorMaterial = new THREE.MeshStandardMaterial({
      color: config.floorColor ?? 0xd99b26,
      roughness: 0.82,
      metalness: 0.06,
    });
    this.floorRingMaterial = new THREE.MeshStandardMaterial({
      color: 0x182024,
      roughness: 0.5,
      metalness: 0.45,
    });
    this.floorCenterMaterial = new THREE.MeshStandardMaterial({
      color: 0x1f272a,
      roughness: 0.6,
      metalness: 0.4,
    });

    this.wallMaterial = new THREE.MeshStandardMaterial({
      color: config.wallColor ?? 0x545d61,
      roughness: 0.90,
      metalness: 0.05,
    });
    this.gateFrameMaterial = new THREE.MeshStandardMaterial({
      color: config.gateFrameColor ?? 0x22272a,
      roughness: 0.35,
      metalness: 0.72,
    });
    this.gateTrimMaterial = new THREE.MeshStandardMaterial({
      color: config.gateTrimColor ?? 0x161a1c,
      roughness: 0.38,
      metalness: 0.78,
    });
    this.gateGlowMaterial = new THREE.MeshStandardMaterial({
      color: config.gateGlowColor ?? 0x38bdf8,
      emissive: 0x0284c7,
      emissiveIntensity: 1.4,
      roughness: 0.2,
      metalness: 0.1,
    });
    this.thresholdMaterial = new THREE.MeshStandardMaterial({
      color: 0x161c1e,
      roughness: 0.35,
      metalness: 0.82,
    });
    this.transomPanelMaterial = new THREE.MeshStandardMaterial({
      color: 0x3d4649,
      roughness: 0.75,
      metalness: 0.18,
    });
    this.portalLightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });
    this.portalCrestMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.3,
      metalness: 0.76,
    });

    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.portalBezelGeometry = createPortalBezelGeometry(
      config.gateWidth,
      config.gateFrameWidth,
      config.wallHeight,
    );
    this.portalLightGeometry = createPortalLightGeometry(
      config.gateWidth,
      config.gateOpeningHeight ?? config.wallHeight * 0.7,
    );
    this.portalCrestGeometry = createPortalCrestGeometry();
    this.collisionBoxes = [];
    this.sectorMeshes = new Map();
    this.floorMaterials = new Map();

    this.debugGroup = new THREE.Group();
    this.debugGroup.name = 'HexMapDebug';
    this.debugGroup.visible = false;
    this.group.add(this.debugGroup);

    this.buildFloors();
    this.buildWallsAndGates();
    this.buildDebugView();
  }

  buildFloors() {
    for (const sector of this.sectors) {
      const color = this.config.sectorColors?.[sector.id]
        ?? getSectorColor(sector.id, sector.order);

      const sectorFloorMaterial = new THREE.MeshStandardMaterial({
        color,
        roughness: 0.80,
        metalness: 0.06,
      });
      this.floorMaterials.set(sector.id, sectorFloorMaterial);

      const floor = new THREE.Mesh(this.floorGeometry, sectorFloorMaterial);
      floor.name = `Floor_${sector.id}`;
      floor.position.set(sector.center.x, this.config.floorHeight, sector.center.z);
      floor.receiveShadow = false;
      floor.userData.sectorId = sector.id;
      this.group.add(floor);
      this.sectorMeshes.set(sector.id, floor);

      // Elegant inner hex border ring on each floor
      const ring = new THREE.Mesh(this.floorRingGeometry, this.floorRingMaterial);
      ring.name = `FloorRing_${sector.id}`;
      ring.position.set(sector.center.x, this.config.floorHeight + 0.02, sector.center.z);
      this.group.add(ring);

      // Central dais / medallion in each hexagon
      const centerDais = new THREE.Mesh(this.floorCenterGeometry, this.floorCenterMaterial);
      centerDais.name = `FloorCenter_${sector.id}`;
      centerDais.position.set(sector.center.x, this.config.floorHeight + 0.03, sector.center.z);
      this.group.add(centerDais);
    }
  }

  addBoxRecord(target, edge, offsetAlong, length, height, thickness, y, extra = {}) {
    const { axisX, axisZ, yaw } = axisForEdge(edge);
    const centerX = edge.center.x + axisX * offsetAlong;
    const centerZ = edge.center.z + axisZ * offsetAlong;
    const record = {
      x: centerX,
      y,
      z: centerZ,
      yaw,
      length,
      height,
      thickness,
      ...extra,
    };
    target.push(record);

    if (extra.collidable !== false) {
      this.collisionBoxes.push({
        x: centerX,
        z: centerZ,
        axisX,
        axisZ,
        halfLength: length / 2,
        halfThickness: thickness / 2,
        minY: y - height / 2,
        maxY: y + height / 2,
      });
    }

    return record;
  }

  buildWallsAndGates() {
    const wallRecords = [];
    const frameRecords = [];
    const thresholdRecords = [];
    const thresholdGlowRecords = [];
    const plinthRecords = [];
    const capitalRecords = [];
    const jambGlowRecords = [];
    const transomBeamRecords = [];
    const transomGlowRecords = [];
    const transomPanelRecords = [];
    const portalBezelRecords = [];
    const portalLightRecords = [];
    const portalCrestRecords = [];

    const { wallHeight, wallThickness, floorHeight, gateWidth, gateFrameWidth, cornerOverlap } = this.config;
    const openingHeight = Math.min(
      this.config.gateOpeningHeight ?? wallHeight * 0.7,
      wallHeight - gateFrameWidth * 1.5,
    );
    const edgeLength = this.config.hexRadius;

    if (gateWidth + 2 * gateFrameWidth >= edgeLength) {
      throw new RangeError('Gate opening and frame must fit within a hex side.');
    }

    const wallY = floorHeight + wallHeight / 2;

    // Outer boundary walls
    for (const edge of this.boundaryEdges) {
      this.addBoxRecord(
        wallRecords,
        edge,
        0,
        edgeLength + cornerOverlap,
        wallHeight,
        wallThickness,
        wallY,
      );
    }

    // Shared edges / Gates:
    // Layered, sector-colored portal hardware sits on both faces of each opening.
    const postDepth = wallThickness + 2.2;
    const postOffset = gateWidth / 2 + gateFrameWidth / 2;

    for (const edge of this.gates) {
      const { axisX, axisZ, yaw } = axisForEdge(edge);
      const normalX = -axisZ;
      const normalZ = axisX;
      const sectorA = this.sectorById.get(edge.aSectorId);
      const sectorB = this.sectorById.get(edge.bSectorId);
      const aSide = Math.sign(
        (sectorA.center.x - edge.center.x) * normalX
        + (sectorA.center.z - edge.center.z) * normalZ,
      ) || 1;
      const portalFaceOffset = postDepth / 2 + 0.38;

      for (const [side, sector] of [[aSide, sectorA], [-aSide, sectorB]]) {
        const accent = getSectorInfo(sector.id, sector.order).accent;
        const faceX = edge.center.x + normalX * side * portalFaceOffset;
        const faceZ = edge.center.z + normalZ * side * portalFaceOffset;
        portalBezelRecords.push({
          x: faceX,
          y: floorHeight,
          z: faceZ,
          yaw,
        });
        portalLightRecords.push({
          x: faceX + normalX * side * 0.62,
          y: floorHeight,
          z: faceZ + normalZ * side * 0.62,
          yaw,
          color: accent,
        });
        portalCrestRecords.push({
          x: faceX + normalX * side * 0.62,
          y: floorHeight + wallHeight + 1.6,
          z: faceZ + normalZ * side * 0.62,
          yaw,
          color: accent,
        });
      }

      const shoulder = gateWidth / 2 + gateFrameWidth;
      const panelSpan = edgeLength / 2 - shoulder;
      const outerExtension = Math.min(cornerOverlap, panelSpan / 4);
      const panelLength = panelSpan + outerExtension;
      const panelOffset = shoulder + panelSpan / 2 + outerExtension / 2;

      // Wall panels flanking the door opening
      this.addBoxRecord(wallRecords, edge, -panelOffset, panelLength, wallHeight, wallThickness, wallY);
      this.addBoxRecord(wallRecords, edge, panelOffset, panelLength, wallHeight, wallThickness, wallY);

      // Core structural gate frame posts (left & right) + top lintel (part of the 36 records)
      this.addBoxRecord(
        frameRecords,
        edge,
        -postOffset,
        gateFrameWidth,
        wallHeight,
        postDepth,
        wallY,
      );
      this.addBoxRecord(
        frameRecords,
        edge,
        postOffset,
        gateFrameWidth,
        wallHeight,
        postDepth,
        wallY,
      );
      this.addBoxRecord(
        frameRecords,
        edge,
        0,
        gateWidth + 2 * gateFrameWidth,
        gateFrameWidth,
        postDepth,
        floorHeight + wallHeight - gateFrameWidth / 2,
        { collidable: false },
      );

      // --- Decorative Architectural Gate Details (collidable: false) ---
      // 1. Threshold plate across the floor between the sectors
      this.addBoxRecord(
        thresholdRecords,
        edge,
        0,
        gateWidth + 0.6,
        0.16,
        wallThickness + 2.6,
        floorHeight + 0.08,
        { collidable: false },
      );

      // 2. Threshold luminous guide runner
      this.addBoxRecord(
        thresholdGlowRecords,
        edge,
        0,
        gateWidth - 1.2,
        0.22,
        0.4,
        floorHeight + 0.11,
        { collidable: false },
      );

      // 3. Post Plinths (Bases)
      this.addBoxRecord(
        plinthRecords,
        edge,
        -postOffset,
        gateFrameWidth + 1.4,
        2.8,
        postDepth + 1.2,
        floorHeight + 1.4,
        { collidable: false },
      );
      this.addBoxRecord(
        plinthRecords,
        edge,
        postOffset,
        gateFrameWidth + 1.4,
        2.8,
        postDepth + 1.2,
        floorHeight + 1.4,
        { collidable: false },
      );

      // 4. Post Capitals (Crowns)
      this.addBoxRecord(
        capitalRecords,
        edge,
        -postOffset,
        gateFrameWidth + 1.4,
        1.8,
        postDepth + 1.2,
        floorHeight + wallHeight - 1.0,
        { collidable: false },
      );
      this.addBoxRecord(
        capitalRecords,
        edge,
        postOffset,
        gateFrameWidth + 1.4,
        1.8,
        postDepth + 1.2,
        floorHeight + wallHeight - 1.0,
        { collidable: false },
      );

      // 5. Bright jamb strips define the usable opening rather than the full wall.
      const jambOffset = gateWidth / 2 - 0.32;
      const jambHeight = openingHeight - 1.2;
      const jambCenterY = floorHeight + jambHeight / 2 + 0.6;
      this.addBoxRecord(
        jambGlowRecords,
        edge,
        -jambOffset,
        0.46,
        jambHeight,
        postDepth * 0.7,
        jambCenterY,
        { collidable: false },
      );
      this.addBoxRecord(
        jambGlowRecords,
        edge,
        jambOffset,
        0.46,
        jambHeight,
        postDepth * 0.7,
        jambCenterY,
        { collidable: false },
      );

      // 6. Deep transom beam, lifted to create a clearer, more human-scaled door.
      const transomHeight = 1.8;
      this.addBoxRecord(
        transomBeamRecords,
        edge,
        0,
        gateWidth + 2 * gateFrameWidth,
        transomHeight,
        postDepth + 0.8,
        floorHeight + openingHeight + transomHeight / 2,
        { collidable: false },
      );

      // 7. Luminous threshold across the top of the open passage.
      this.addBoxRecord(
        transomGlowRecords,
        edge,
        0,
        gateWidth,
        0.28,
        1.2,
        floorHeight + openingHeight + 0.03,
        { collidable: false },
      );

      // 8. Inset header panel above the clear opening.
      const panelBase = openingHeight + transomHeight;
      const panelHeight = Math.max(1, wallHeight - panelBase - 0.8);
      this.addBoxRecord(
        transomPanelRecords,
        edge,
        0,
        gateWidth + 0.4,
        panelHeight,
        wallThickness,
        floorHeight + panelBase + panelHeight / 2,
        { collidable: false },
      );
    }

    // Required core instanced meshes
    this.wallInstancedMesh = this.createInstancedBoxes(
      wallRecords,
      this.wallMaterial,
      'StructuralWalls',
    );
    this.frameInstancedMesh = this.createInstancedBoxes(
      frameRecords,
      this.gateFrameMaterial,
      'OpenGateFrames',
    );
    this.wallRecordCount = wallRecords.length;
    this.frameRecordCount = frameRecords.length;

    // Architectural decorative gate enhancements
    this.portalThresholds = this.createInstancedBoxes(
      thresholdRecords,
      this.thresholdMaterial,
      'PortalThresholds',
    );
    this.portalThresholdGlow = this.createInstancedBoxes(
      thresholdGlowRecords,
      this.gateGlowMaterial,
      'PortalThresholdGlow',
    );
    this.portalPlinths = this.createInstancedBoxes(
      plinthRecords,
      this.gateTrimMaterial,
      'PortalPlinths',
    );
    this.portalCapitals = this.createInstancedBoxes(
      capitalRecords,
      this.gateTrimMaterial,
      'PortalCapitals',
    );
    this.portalJambGlow = this.createInstancedBoxes(
      jambGlowRecords,
      this.gateGlowMaterial,
      'PortalJambGlow',
    );
    this.portalTransomBeams = this.createInstancedBoxes(
      transomBeamRecords,
      this.gateTrimMaterial,
      'PortalTransomBeams',
    );
    this.portalTransomGlow = this.createInstancedBoxes(
      transomGlowRecords,
      this.gateGlowMaterial,
      'PortalTransomGlow',
    );
    this.portalTransomPanels = this.createInstancedBoxes(
      transomPanelRecords,
      this.transomPanelMaterial,
      'PortalTransomPanels',
    );
    this.portalBezels = this.createInstancedGeometry(
      this.portalBezelGeometry,
      this.gateTrimMaterial,
      portalBezelRecords,
      'PortalBevelledBezels',
    );
    this.portalLightRings = this.createInstancedGeometry(
      this.portalLightGeometry,
      this.portalLightMaterial,
      portalLightRecords,
      'PortalSectorLightRings',
    );
    this.portalCrests = this.createInstancedGeometry(
      this.portalCrestGeometry,
      this.portalCrestMaterial,
      portalCrestRecords,
      'PortalHexCrests',
    );
  }

  createInstancedGeometry(geometry, material, records, name) {
    const mesh = new THREE.InstancedMesh(geometry, material, records.length);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const transform = new THREE.Object3D();

    records.forEach((record, index) => {
      transform.position.set(record.x, record.y, record.z);
      transform.rotation.set(0, record.yaw, 0);
      transform.scale.setScalar(record.scale ?? 1);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
      if (record.color !== undefined) mesh.setColorAt(index, new THREE.Color(record.color));
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  createInstancedBoxes(records, material, name) {
    const mesh = new THREE.InstancedMesh(this.boxGeometry, material, records.length);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    const transform = new THREE.Object3D();

    records.forEach((record, index) => {
      transform.position.set(record.x, record.y, record.z);
      transform.rotation.set(0, record.yaw, 0);
      transform.scale.set(record.length, record.height, record.thickness);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    });

    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    this.group.add(mesh);
    return mesh;
  }

  buildDebugView() {
    const boundaryPositions = [];
    for (const sector of this.sectors) {
      const vertices = getHexVertices(sector.center.x, sector.center.z, this.config.hexRadius);
      for (let i = 0; i < vertices.length; i += 1) {
        const start = vertices[i];
        const end = vertices[(i + 1) % vertices.length];
        boundaryPositions.push(
          start.x, this.config.floorHeight + 0.35, start.z,
          end.x, this.config.floorHeight + 0.35, end.z,
        );
      }

      const info = getSectorInfo(sector.id, sector.order);
      const colorHex = `#${info.color.toString(16).padStart(6, '0')}`;
      const label = makeCanvasLabel(sector.id, colorHex, info.name);
      label.position.set(
        sector.center.x,
        this.config.floorHeight + this.config.wallHeight + 14,
        sector.center.z,
      );
      this.debugGroup.add(label);
    }

    const boundaryGeometry = new THREE.BufferGeometry();
    boundaryGeometry.setAttribute('position', new THREE.Float32BufferAttribute(boundaryPositions, 3));
    const boundaryLines = new THREE.LineSegments(
      boundaryGeometry,
      new THREE.LineBasicMaterial({ color: 0x3bd2c5, transparent: true, opacity: 0.86, depthTest: false }),
    );
    boundaryLines.renderOrder = 1000;
    this.debugGroup.add(boundaryLines);

    const gatePositions = [];
    for (const edge of this.gates) {
      const dx = edge.end.x - edge.start.x;
      const dz = edge.end.z - edge.start.z;
      const length = Math.hypot(dx, dz);
      const normalX = -dz / length;
      const normalZ = dx / length;
      const markerLength = 14;
      gatePositions.push(
        edge.center.x - normalX * markerLength / 2, this.config.floorHeight + 0.7, edge.center.z - normalZ * markerLength / 2,
        edge.center.x + normalX * markerLength / 2, this.config.floorHeight + 0.7, edge.center.z + normalZ * markerLength / 2,
      );
    }
    const gateGeometry = new THREE.BufferGeometry();
    gateGeometry.setAttribute('position', new THREE.Float32BufferAttribute(gatePositions, 3));
    const gateLines = new THREE.LineSegments(
      gateGeometry,
      new THREE.LineBasicMaterial({ color: 0xf0bc69, depthTest: false }),
    );
    gateLines.renderOrder = 1002;
    this.debugGroup.add(gateLines);

    const originPoints = [
      new THREE.Vector3(-18, this.config.floorHeight + 1, 0),
      new THREE.Vector3(18, this.config.floorHeight + 1, 0),
      new THREE.Vector3(0, this.config.floorHeight + 1, -18),
      new THREE.Vector3(0, this.config.floorHeight + 1, 18),
    ];
    const originGeometry = new THREE.BufferGeometry().setFromPoints(originPoints);
    const originAxes = new THREE.LineSegments(
      originGeometry,
      new THREE.LineBasicMaterial({ color: 0xe5e9e7, depthTest: false }),
    );
    originAxes.renderOrder = 1003;
    this.debugGroup.add(originAxes);

    const originMarker = new THREE.Mesh(
      new THREE.SphereGeometry(2.4, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xf0bc69, depthTest: false }),
    );
    originMarker.position.set(0, this.config.floorHeight + 2.5, 0);
    originMarker.renderOrder = 1004;
    this.debugGroup.add(originMarker);

    this.playerMarker = new THREE.Mesh(
      new THREE.SphereGeometry(3, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xed8068, depthTest: false }),
    );
    this.playerMarker.position.set(0, this.config.floorHeight + 3, 0);
    this.playerMarker.renderOrder = 1005;
    this.debugGroup.add(this.playerMarker);
  }

  setDebugVisible(visible) {
    this.debugGroup.visible = visible;
  }

  update(elapsedSeconds = 0) {
    const pulse = 1.42 + (Math.sin(elapsedSeconds * 1.8) + 1) * 0.22;
    this.gateGlowMaterial.emissiveIntensity = pulse;
  }

  updateDebugPlayer(position) {
    if (!this.playerMarker) return;
    this.playerMarker.position.set(position.x, position.y + 2.5, position.z);
  }

  getSector(id) {
    return this.sectorById.get(id) ?? null;
  }

  getSectorAt(x, z) {
    for (const sector of this.sectors) {
      if (isPointInsideHex(
        x,
        z,
        sector.center.x,
        sector.center.z,
        this.config.hexRadius,
      )) return sector;
    }
    return null;
  }

  getFloorHeightAt(x, z) {
    for (const sector of this.sectors) {
      if (isPointInsideHex(
        x,
        z,
        sector.center.x,
        sector.center.z,
        this.config.hexRadius,
      )) return this.config.floorHeight;
    }
    return null;
  }

  resolveHorizontalPosition(
    x,
    z,
    radius,
    playerBottomY = this.config.floorHeight,
    playerHeight = 1.8,
  ) {
    let resolvedX = x;
    let resolvedZ = z;

    // A few inexpensive passes resolve corners where two perpendicular-ish
    // wall segments meet while preserving smooth wall sliding.
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = false;

      for (const box of this.collisionBoxes) {
        const overlapsVertically = playerBottomY < box.maxY
          && playerBottomY + playerHeight > box.minY;
        if (!overlapsVertically) continue;

        const deltaX = resolvedX - box.x;
        const deltaZ = resolvedZ - box.z;
        const along = deltaX * box.axisX + deltaZ * box.axisZ;
        const across = deltaX * -box.axisZ + deltaZ * box.axisX;
        const nearestAlong = THREE.MathUtils.clamp(along, -box.halfLength, box.halfLength);
        const nearestAcross = THREE.MathUtils.clamp(across, -box.halfThickness, box.halfThickness);
        let pushAlong = along - nearestAlong;
        let pushAcross = across - nearestAcross;
        let distanceSquared = pushAlong * pushAlong + pushAcross * pushAcross;

        if (distanceSquared >= radius * radius) continue;

        if (distanceSquared < 1e-12) {
          const alongPenetration = box.halfLength + radius - Math.abs(along);
          const acrossPenetration = box.halfThickness + radius - Math.abs(across);
          if (alongPenetration < acrossPenetration) {
            pushAlong = (along < 0 ? -1 : 1) * alongPenetration;
            pushAcross = 0;
          } else {
            pushAlong = 0;
            pushAcross = (across < 0 ? -1 : 1) * acrossPenetration;
          }

          // The center is inside the wall rectangle. Push it straight out by
          // the full penetration depth instead of treating it as a near point.
          resolvedX += pushAlong * box.axisX + pushAcross * -box.axisZ;
          resolvedZ += pushAlong * box.axisZ + pushAcross * box.axisX;
          changed = true;
          continue;
        }

        const distance = Math.sqrt(distanceSquared);
        if (distance < 1e-8) continue;
        const correction = (radius - distance) / distance;
        const correctionAlong = pushAlong * correction;
        const correctionAcross = pushAcross * correction;
        resolvedX += correctionAlong * box.axisX + correctionAcross * -box.axisZ;
        resolvedZ += correctionAlong * box.axisZ + correctionAcross * box.axisX;
        changed = true;
      }

      if (!changed) break;
    }

    return { x: resolvedX, z: resolvedZ };
  }
}
