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
      roughness: 0.28,
      metalness: 0.82,
    });
    this.portalTrimMaterial = new THREE.MeshStandardMaterial({
      color: 0x708186,
      roughness: 0.28,
      metalness: 0.86,
    });
    this.doorBodyMaterial = new THREE.MeshStandardMaterial({
      color: 0x101a1e,
      roughness: 0.24,
      metalness: 0.88,
    });
    this.doorPlateMaterial = new THREE.MeshStandardMaterial({
      color: 0x27363b,
      roughness: 0.31,
      metalness: 0.82,
    });
    this.doorInsetMaterial = new THREE.MeshStandardMaterial({
      color: 0x111d21,
      roughness: 0.42,
      metalness: 0.72,
    });
    this.doorGrooveMaterial = new THREE.MeshStandardMaterial({
      color: 0x080f12,
      roughness: 0.48,
      metalness: 0.62,
    });
    this.portalLightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      toneMapped: false,
    });
    this.boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.doorGlyphGeometry = new THREE.RingGeometry(0.42, 0.58, 6);
    this.doorPartMeshes = new Map();
    this.doorPartRecords = new Map();
    this.doorTransform = new THREE.Object3D();
    this.portalYawQuaternion = new THREE.Quaternion();
    this.doorLocalYQuaternion = new THREE.Quaternion();
    this.doorLocalZQuaternion = new THREE.Quaternion();
    this.doorYAxis = new THREE.Vector3(0, 1, 0);
    this.doorZAxis = new THREE.Vector3(0, 0, 1);
    this.collisionBoxes = [];
    this.doors = [];
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


    }
  }

  addBoxRecord(target, edge, offsetAlong, length, height, thickness, y, extra = {}) {
    const { axisX, axisZ, yaw } = axisForEdge(edge);
    const offsetNormal = extra.offsetNormal ?? 0;
    const centerX = edge.center.x + axisX * offsetAlong - axisZ * offsetNormal;
    const centerZ = edge.center.z + axisZ * offsetAlong + axisX * offsetNormal;
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
    const trimRecords = [];
    const lightRecords = [];
    const { wallHeight, wallThickness, floorHeight, gateWidth, gateFrameWidth, cornerOverlap } = this.config;
    const openingHeight = Math.min(
      this.config.gateOpeningHeight ?? wallHeight * 0.7,
      wallHeight - gateFrameWidth - 0.5,
    );
    const edgeLength = this.config.hexRadius;
    const postWidth = Math.max(4.2, gateFrameWidth * 2);
    const frameDepth = wallThickness + 1.4;
    const frameHeight = openingHeight + gateFrameWidth;
    const postOffset = gateWidth / 2 + postWidth / 2;

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

      for (const side of [-1, 1]) {
        this.addBoxRecord(wallRecords, edge, side * panelOffset, panelLength,
          wallHeight, wallThickness, wallY);
        // Deep, armored jambs anchor each sliding leaf to the wall.
        this.addBoxRecord(frameRecords, edge, side * postOffset, postWidth,
          frameHeight, frameDepth, floorHeight + frameHeight / 2);
      }

      // A solid lintel above the portal remains a real flight collision.
      const headerHeight = wallHeight - frameHeight;
      if (headerHeight > 0) {
        this.addBoxRecord(wallRecords, edge, 0, gateWidth + 2 * gateFrameWidth,
          headerHeight, wallThickness, floorHeight + frameHeight + headerHeight / 2);
      }

      // A machined cross-beam and crown turn the simple opening into a massive
      // portal housing while preserving the original walkable clear width.
      this.addBoxRecord(frameRecords, edge, 0, gateWidth + 2 * postWidth,
        gateFrameWidth, frameDepth, floorHeight + openingHeight + gateFrameWidth / 2);
      this.addBoxRecord(frameRecords, edge, 0, gateWidth + 2 * postWidth + 2.4,
        1.5, frameDepth + 1.2, floorHeight + wallHeight - 0.9,
        { collidable: false });

      const normalX = -axisZ;
      const normalZ = axisX;
      for (const sectorId of [edge.aSectorId, edge.bSectorId]) {
        const sector = this.sectorById.get(sectorId);
        const faceSign = Math.sign(
          (sector.center.x - edge.center.x) * normalX
          + (sector.center.z - edge.center.z) * normalZ,
        ) || 1;
        const faceOffset = faceSign * (frameDepth / 2 + 0.08);
        const accent = getSectorInfo(sector.id, sector.order).accent;

        // Fine metal reveals, repeated armor bands and sector-coded light rails
        // are mounted on both faces of every portal.
        for (const postSide of [-1, 1]) {
          const jambX = postSide * (gateWidth / 2 + 0.38);
          this.addBoxRecord(trimRecords, edge, jambX, 0.24,
            openingHeight - 1.2, 0.16,
            floorHeight + openingHeight / 2,
            { offsetNormal: faceOffset, collidable: false });
          this.addBoxRecord(trimRecords, edge,
            postSide * (postOffset + postWidth * 0.34), 0.28,
            frameHeight - 2.2, 0.14,
            floorHeight + frameHeight / 2,
            { offsetNormal: faceOffset, collidable: false });

          for (const bandY of [floorHeight + 2.4, floorHeight + openingHeight * 0.52]) {
            this.addBoxRecord(trimRecords, edge, postSide * postOffset, postWidth - 0.9,
              0.28, 0.14, bandY,
              { offsetNormal: faceOffset, collidable: false });
          }

          lightRecords.push({
            x: 0,
            y: floorHeight + openingHeight / 2,
            z: 0,
            yaw,
            color: accent,
            length: 0.18,
            height: openingHeight - 1.6,
            thickness: 0.12,
            offsetAlong: jambX,
            offsetNormal: faceOffset,
            edge,
          });
        }

        this.addBoxRecord(trimRecords, edge, 0, gateWidth - 1.2,
          0.24, 0.12, floorHeight + openingHeight - 0.62,
          { offsetNormal: faceOffset, collidable: false });
        lightRecords.push({
          x: 0,
          y: floorHeight + openingHeight - 0.7,
          z: 0,
          yaw,
          color: accent,
          length: gateWidth - 1.6,
          height: 0.18,
          thickness: 0.12,
          offsetNormal: faceOffset,
          edge,
        });
      }
    }

    this.wallInstancedMesh = this.createInstancedBoxes(wallRecords, this.wallMaterial, 'StructuralWalls');
    this.frameInstancedMesh = this.createInstancedBoxes(frameRecords, this.gateFrameMaterial, 'PortalExoskeletons');
    this.portalTrim = this.createInstancedBoxes(trimRecords, this.portalTrimMaterial, 'PortalArmourDetails');
    this.portalLights = this.createPortalLightInstances(lightRecords);
    this.wallRecordCount = wallRecords.length;
    this.frameRecordCount = frameRecords.length;
    this.trimRecordCount = trimRecords.length;

    this.buildPortalCrests(frameDepth);
    this.buildSlidingDoors(openingHeight, frameDepth);
  }

  createPortalLightInstances(records) {
    const positionedRecords = records.map((record) => {
      if (!record.edge) return record;
      const { axisX, axisZ, yaw } = axisForEdge(record.edge);
      const along = record.offsetAlong ?? 0;
      const normal = record.offsetNormal ?? 0;
      return {
        ...record,
        x: record.edge.center.x + axisX * along - axisZ * normal,
        z: record.edge.center.z + axisZ * along + axisX * normal,
        yaw,
      };
    });
    return this.createInstancedBoxes(positionedRecords, this.portalLightMaterial, 'PortalLightStrips');
  }

  buildPortalCrests(frameDepth) {
    this.portalCrestsGroup = new THREE.Group();
    this.portalCrestsGroup.name = 'PortalHexCrests';
    this.group.add(this.portalCrestsGroup);

    const faceCount = this.gates.length * 2;
    const baseMesh = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(2.7, 2.7, 0.72, 6),
      this.gateFrameMaterial,
      faceCount,
    );
    const ringMesh = new THREE.InstancedMesh(
      new THREE.RingGeometry(2.12, 2.4, 6),
      this.portalLightMaterial,
      faceCount,
    );
    const coreMesh = new THREE.InstancedMesh(
      new THREE.CircleGeometry(0.9, 6),
      this.portalLightMaterial,
      faceCount,
    );
    const chevronMesh = new THREE.InstancedMesh(
      this.boxGeometry,
      this.portalLightMaterial,
      faceCount * 2,
    );
    baseMesh.name = 'PortalCrest_HexBases';
    ringMesh.name = 'PortalCrest_AccentRings';
    coreMesh.name = 'PortalCrest_Cores';
    chevronMesh.name = 'PortalCrest_Chevrons';

    const transform = new THREE.Object3D();
    const parentRotation = new THREE.Quaternion();
    const detailRotation = new THREE.Quaternion();
    const rotateX = new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(1, 0, 0),
      Math.PI / 2,
    );
    const rotateY = new THREE.Quaternion().setFromAxisAngle(this.doorYAxis, Math.PI);
    let faceIndex = 0;
    let chevronIndex = 0;

    for (const edge of this.gates) {
      const { yaw } = axisForEdge(edge);
      const normalX = Math.sin(yaw);
      const normalZ = Math.cos(yaw);
      parentRotation.setFromAxisAngle(this.doorYAxis, yaw);

      for (const faceSign of [-1, 1]) {
        const sector = [edge.aSectorId, edge.bSectorId]
          .map((id) => this.sectorById.get(id))
          .find((candidate) => (
            (candidate.center.x - edge.center.x) * normalX * faceSign
            + (candidate.center.z - edge.center.z) * normalZ * faceSign
          ) > 0);
        const accent = getSectorInfo(sector.id, sector.order).accent;
        const baseZ = faceSign * (frameDepth / 2 + 0.16);
        const crestY = this.config.floorHeight + this.config.wallHeight - 4.4;
        const crestX = edge.center.x + normalX * baseZ;
        const crestZ = edge.center.z + normalZ * baseZ;

        transform.position.set(crestX, crestY, crestZ);
        transform.quaternion.copy(parentRotation).multiply(rotateX);
        transform.scale.set(1, 1, 1);
        transform.updateMatrix();
        baseMesh.setMatrixAt(faceIndex, transform.matrix);

        for (const [mesh, depthOffset] of [[ringMesh, 0.39], [coreMesh, 0.4]]) {
          const outward = faceSign * depthOffset;
          transform.position.set(
            crestX + normalX * outward,
            crestY,
            crestZ + normalZ * outward,
          );
          transform.quaternion.copy(parentRotation);
          if (faceSign < 0) transform.quaternion.multiply(rotateY);
          transform.updateMatrix();
          mesh.setMatrixAt(faceIndex, transform.matrix);
          mesh.setColorAt(faceIndex, new THREE.Color(accent));
        }

        // A restrained double-chevron is kept as two tiny instanced bars per
        // crest so the art detail costs no additional draw calls per portal.
        for (const direction of [-1, 1]) {
          const localX = direction * 0.18;
          const localZ = faceSign * 0.46;
          transform.position.set(
            edge.center.x + normalX * baseZ + normalX * localZ + Math.cos(yaw) * localX,
            crestY,
            edge.center.z + normalZ * baseZ + normalZ * localZ - Math.sin(yaw) * localX,
          );
          detailRotation.setFromAxisAngle(this.doorZAxis, direction * 0.46);
          transform.quaternion.copy(parentRotation);
          if (faceSign < 0) transform.quaternion.multiply(rotateY);
          transform.quaternion.multiply(detailRotation);
          transform.scale.set(0.12, 0.66, 0.06);
          transform.updateMatrix();
          chevronMesh.setMatrixAt(chevronIndex, transform.matrix);
          chevronMesh.setColorAt(chevronIndex, new THREE.Color(0xdafcf4));
          chevronIndex += 1;
        }
        faceIndex += 1;
      }
    }

    for (const mesh of [baseMesh, ringMesh, coreMesh, chevronMesh]) {
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.computeBoundingBox();
      mesh.computeBoundingSphere();
      this.portalCrestsGroup.add(mesh);
    }
    this.portalCrestBases = baseMesh;
    this.portalCrestRings = ringMesh;
    this.portalCrestCores = coreMesh;
    this.portalCrestChevrons = chevronMesh;
  }

  addDoorPart(door, type, leafSide, faceSign, localX, localY, localZ,
    scaleX, scaleY, scaleZ, options = {}) {
    const part = {
      type,
      leafSide,
      faceSign,
      localX,
      localY,
      localZ,
      scaleX,
      scaleY,
      scaleZ,
      color: options.color,
      rotationY: options.rotationY ?? 0,
      rotationZ: options.rotationZ ?? 0,
    };
    door.parts.push(part);
    this.doorPartRecords.get(type).push(part);
  }

  addDoorLeafParts(door, width, height, depth, openingHeight,
    faceSign, leafSide, accentColor) {
    const centerY = openingHeight / 2;
    const faceZ = faceSign * (depth / 2 + 0.045);
    const innerX = -leafSide * width * 0.27;

    this.addDoorPart(door, 'body', leafSide, faceSign,
      0, centerY, 0, width, height, depth);
    this.addDoorPart(door, 'armour', leafSide, faceSign,
      0, centerY, faceZ, width - 0.34, height - 0.42, 0.12);
    this.addDoorPart(door, 'inset', leafSide, faceSign,
      0, centerY, faceSign * (depth / 2 + 0.13), width * 0.68, height * 0.72, 0.08);

    const railZ = faceSign * (depth / 2 + 0.19);
    for (const railSide of [-1, 1]) {
      this.addDoorPart(door, 'trim', leafSide, faceSign,
        railSide * (width / 2 - 0.23), centerY, railZ, 0.17, height * 0.91, 0.1);
    }

    this.addDoorPart(door, 'energy', leafSide, faceSign,
      innerX, centerY, faceSign * (depth / 2 + 0.205), 0.18, height * 0.62, 0.085,
      { color: accentColor });

    for (const seamY of [-0.31, 0.31]) {
      this.addDoorPart(door, 'groove', leafSide, faceSign,
        0, centerY + seamY * height, faceSign * (depth / 2 + 0.19),
        width * 0.63, 0.105, 0.07);
    }

    // The paired, colored hex lock marks align as the two leaves meet.
    this.addDoorPart(door, 'glyph', leafSide, faceSign,
      innerX, centerY + height * 0.18, faceSign * (depth / 2 + 0.22),
      1, 1, 1, { color: accentColor, rotationY: faceSign < 0 ? Math.PI : 0 });
  }

  createDoorPartInstances() {
    const definitions = {
      body: { geometry: this.boxGeometry, material: this.doorBodyMaterial, name: 'DoorLeaves_TitaniumCores' },
      armour: { geometry: this.boxGeometry, material: this.doorPlateMaterial, name: 'DoorLeaves_ArmourPlates' },
      inset: { geometry: this.boxGeometry, material: this.doorInsetMaterial, name: 'DoorLeaves_RecessedPanels' },
      trim: { geometry: this.boxGeometry, material: this.portalTrimMaterial, name: 'DoorLeaves_EdgeRails' },
      energy: { geometry: this.boxGeometry, material: this.portalLightMaterial, name: 'DoorLeaves_EnergySpines' },
      groove: { geometry: this.boxGeometry, material: this.doorGrooveMaterial, name: 'DoorLeaves_ArmourSeams' },
      glyph: { geometry: this.doorGlyphGeometry, material: this.portalLightMaterial, name: 'DoorLeaves_HexLockGlyphs' },
    };

    for (const [type, definition] of Object.entries(definitions)) {
      const records = this.doorPartRecords.get(type);
      const mesh = new THREE.InstancedMesh(definition.geometry, definition.material, records.length);
      mesh.name = definition.name;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      records.forEach((record, index) => {
        record.instanceIndex = index;
        if (record.color !== undefined) mesh.setColorAt(index, new THREE.Color(record.color));
      });
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      this.doorPartMeshes.set(type, mesh);
      this.group.add(mesh);
    }
  }

  buildSlidingDoors(openingHeight, frameDepth) {
    const gateWidth = this.config.gateWidth;
    const leafWidth = gateWidth / 2 + 0.36;
    const leafHeight = openingHeight - 0.38;
    const leafDepth = 1.05;
    const slideDistance = gateWidth * 0.96;
    const faceOffset = frameDepth / 2 - leafDepth / 2 + 0.12;
    this.doorPartRecords = new Map(
      ['body', 'armour', 'inset', 'trim', 'energy', 'groove', 'glyph']
        .map((type) => [type, []]),
    );

    for (const edge of this.gates) {
      const { axisX, axisZ, yaw } = axisForEdge(edge);
      const normalX = -axisZ;
      const normalZ = axisX;
      const sectors = [edge.aSectorId, edge.bSectorId].map((id) => this.sectorById.get(id));
      const positiveSector = sectors.find((sector) => (
        (sector.center.x - edge.center.x) * normalX
        + (sector.center.z - edge.center.z) * normalZ
      ) > 0);
      const negativeSector = sectors.find((sector) => sector !== positiveSector);
      const portal = new THREE.Group();
      portal.name = `SlidingPortal_${edge.id}`;
      portal.position.set(edge.center.x, this.config.floorHeight, edge.center.z);
      portal.rotation.y = yaw;
      this.group.add(portal);

      const door = {
        edge,
        portal,
        axisX,
        axisZ,
        openAmount: 0,
        closeTimer: 0,
        slideDistance,
        faceOffset,
        parts: [],
        collisionBoxes: [],
      };

      for (const faceSign of [-1, 1]) {
        const sector = faceSign > 0 ? positiveSector : negativeSector;
        const accentColor = getSectorInfo(sector.id, sector.order).accent;
        for (const leafSide of [-1, 1]) {
          this.addDoorLeafParts(
            door,
            leafWidth,
            leafHeight,
            leafDepth,
            openingHeight,
            faceSign,
            leafSide,
            accentColor,
          );
        }
      }

      for (const leafSide of [-1, 1]) {
        const collisionBox = {
          x: edge.center.x + axisX * leafSide * gateWidth / 4,
          z: edge.center.z + axisZ * leafSide * gateWidth / 4,
          axisX,
          axisZ,
          halfLength: leafWidth / 2,
          halfThickness: (this.config.wallThickness + 0.28) / 2,
          minY: this.config.floorHeight,
          maxY: this.config.floorHeight + openingHeight,
          door,
          leafSide,
        };
        door.collisionBoxes.push(collisionBox);
        this.collisionBoxes.push(collisionBox);
      }

      this.doors.push(door);
    }

    this.createDoorPartInstances();
    // Shared instance matrices stay current even before the first animation tick.
    for (const door of this.doors) this.syncSlidingDoor(door);
    this.flushDoorPartMatrices();
  }

  syncSlidingDoor(door) {
    const centerOffset = this.config.gateWidth / 4 + door.openAmount * door.slideDistance;
    for (const box of door.collisionBoxes) {
      const offset = box.leafSide * centerOffset;
      box.x = door.edge.center.x + door.axisX * offset;
      box.z = door.edge.center.z + door.axisZ * offset;
    }

    this.portalYawQuaternion.setFromAxisAngle(this.doorYAxis, door.portal.rotation.y);
    for (const part of door.parts) {
      const mesh = this.doorPartMeshes.get(part.type);
      if (!mesh) continue;
      const localX = part.leafSide * centerOffset + part.localX;
      const localZ = part.faceSign * door.faceOffset + part.localZ;
      const transform = this.doorTransform;
      transform.position.set(
        door.edge.center.x + door.axisX * localX - door.axisZ * localZ,
        this.config.floorHeight + part.localY,
        door.edge.center.z + door.axisZ * localX + door.axisX * localZ,
      );
      transform.quaternion.copy(this.portalYawQuaternion);
      if (part.rotationY) {
        this.doorLocalYQuaternion.setFromAxisAngle(this.doorYAxis, part.rotationY);
        transform.quaternion.multiply(this.doorLocalYQuaternion);
      }
      if (part.rotationZ) {
        this.doorLocalZQuaternion.setFromAxisAngle(this.doorZAxis, part.rotationZ);
        transform.quaternion.multiply(this.doorLocalZQuaternion);
      }
      transform.scale.set(part.scaleX, part.scaleY, part.scaleZ);
      transform.updateMatrix();
      mesh.setMatrixAt(part.instanceIndex, transform.matrix);
    }
  }

  flushDoorPartMatrices() {
    for (const mesh of this.doorPartMeshes.values()) mesh.instanceMatrix.needsUpdate = true;
  }

  update(deltaSeconds, playerPosition) {
    if (!playerPosition) return;
    const dt = Math.max(0, deltaSeconds);
    const openRadius = this.config.doorOpenRadius ?? 48;
    const closeDelay = this.config.doorCloseDelay ?? 1.05;
    const motionSpeed = this.config.doorMotionSpeed ?? 3.2;
    let matricesDirty = false;

    for (const door of this.doors) {
      const distance = Math.hypot(
        playerPosition.x - door.edge.center.x,
        playerPosition.z - door.edge.center.z,
      );
      if (distance <= openRadius) {
        door.closeTimer = closeDelay;
      } else {
        door.closeTimer = Math.max(0, door.closeTimer - dt);
      }

      const target = door.closeTimer > 0 ? 1 : 0;
      const change = Math.min(Math.abs(target - door.openAmount), motionSpeed * dt);
      if (change === 0) continue;
      door.openAmount += Math.sign(target - door.openAmount) * change;
      this.syncSlidingDoor(door);
      matricesDirty = true;
    }
    if (matricesDirty) this.flushDoorPartMatrices();
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
