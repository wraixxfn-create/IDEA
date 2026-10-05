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
    this.portalLightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });

    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
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
      floor.receiveShadow = true;
      floor.userData.sectorId = sector.id;
      this.group.add(floor);
      this.sectorMeshes.set(sector.id, floor);

      // Elegant inner hex border ring on each floor
      const ring = new THREE.Mesh(this.floorRingGeometry, this.floorRingMaterial);
      ring.name = `FloorRing_${sector.id}`;
      ring.position.set(sector.center.x, this.config.floorHeight + 0.02, sector.center.z);
      ring.receiveShadow = true;
      this.group.add(ring);


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
    const lightRecords = [];
    const { wallHeight, wallThickness, floorHeight, gateWidth, gateFrameWidth, cornerOverlap } = this.config;
    const openingHeight = Math.min(
      this.config.gateOpeningHeight ?? wallHeight * 0.7,
      wallHeight - gateFrameWidth,
    );
    const edgeLength = this.config.hexRadius;

    if (gateWidth + 2 * gateFrameWidth >= edgeLength) {
      throw new RangeError('Gate opening and frame must fit within a hex side.');
    }

    const wallY = floorHeight + wallHeight / 2;
    for (const edge of this.boundaryEdges) {
      this.addBoxRecord(wallRecords, edge, 0, edgeLength + cornerOverlap,
        wallHeight, wallThickness, wallY);
    }

    for (const edge of this.gates) {
      const { axisX, axisZ, yaw } = axisForEdge(edge);
      const shoulder = gateWidth / 2 + gateFrameWidth;
      const panelSpan = edgeLength / 2 - shoulder;
      const extension = Math.min(cornerOverlap, panelSpan / 4);
      const panelLength = panelSpan + extension;
      const panelOffset = shoulder + panelSpan / 2 + extension / 2;
      const frameDepth = wallThickness + 0.6;
      const frameHeight = openingHeight + gateFrameWidth;
      const postOffset = gateWidth / 2 + gateFrameWidth / 2;

      for (const side of [-1, 1]) {
        this.addBoxRecord(wallRecords, edge, side * panelOffset, panelLength,
          wallHeight, wallThickness, wallY);
        this.addBoxRecord(frameRecords, edge, side * postOffset, gateFrameWidth,
          frameHeight, frameDepth, floorHeight + frameHeight / 2);
      }
      // A solid header fills the tall wall above the actual door. Its collision
      // matches the visible geometry, including when the player is flying.
      const headerHeight = wallHeight - frameHeight;
      if (headerHeight > 0) {
        this.addBoxRecord(wallRecords, edge, 0, gateWidth + 2 * gateFrameWidth,
          headerHeight, wallThickness, floorHeight + frameHeight + headerHeight / 2);
      }
      this.addBoxRecord(frameRecords, edge, 0, gateWidth, gateFrameWidth,
        frameDepth, floorHeight + openingHeight + gateFrameWidth / 2);

      // Straight, flush light strips on both faces: no crests, tubes, bulky
      // plinths or raised thresholds intruding into the passage.
      const normalX = -axisZ;
      const normalZ = axisX;
      for (const sectorId of [edge.aSectorId, edge.bSectorId]) {
        const sector = this.sectorById.get(sectorId);
        const side = Math.sign(
          (sector.center.x - edge.center.x) * normalX
          + (sector.center.z - edge.center.z) * normalZ,
        ) || 1;
        const faceOffset = side * (frameDepth / 2 + 0.04);
        const color = getSectorInfo(sector.id, sector.order).accent;
        const face = {
          x: edge.center.x + normalX * faceOffset,
          z: edge.center.z + normalZ * faceOffset,
          yaw,
          color,
          thickness: 0.08,
        };
        for (const postSide of [-1, 1]) {
          lightRecords.push({ ...face,
            x: face.x + axisX * postSide * postOffset,
            z: face.z + axisZ * postSide * postOffset,
            y: floorHeight + openingHeight / 2,
            length: 0.16, height: openingHeight,
          });
        }
        lightRecords.push({ ...face,
          y: floorHeight + openingHeight + gateFrameWidth / 2,
          length: gateWidth + gateFrameWidth, height: 0.16,
        });
      }
    }

    this.wallInstancedMesh = this.createInstancedBoxes(wallRecords, this.wallMaterial, 'StructuralWalls');
    this.frameInstancedMesh = this.createInstancedBoxes(frameRecords, this.gateFrameMaterial, 'OpenGateFrames');
    this.portalLights = this.createInstancedBoxes(lightRecords, this.portalLightMaterial, 'PortalLightStrips');
    this.wallRecordCount = wallRecords.length;
    this.frameRecordCount = frameRecords.length;
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
      if (record.color !== undefined) mesh.setColorAt(index, new THREE.Color(record.color));
    });

    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = name !== 'PortalLightStrips';
    mesh.receiveShadow = name !== 'PortalLightStrips';
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
