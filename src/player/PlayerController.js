import * as THREE from 'three';

const MOVEMENT_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight',
  'Space', 'ControlLeft', 'ControlRight',
]);

export class PlayerController {
  constructor(camera, domElement, world, config) {
    this.camera = camera;
    this.domElement = domElement;
    this.world = world;
    this.config = config;
    this.position = new THREE.Vector3(0, world.config.floorHeight, 0);
    this.velocityY = 0;
    this.yaw = 0;
    this.pitch = config.initialCameraPitch ?? 0.28;
    this.facingYaw = 0;
    this.cameraDistance = config.cameraDistance ?? 10;
    this.keys = new Set();
    this.isLocked = false;
    this.isFlying = false;
    this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
    this.onLockChange = () => {};
    this.onFlightChange = () => {};
    this.lastSafeX = this.position.x;
    this.lastSafeZ = this.position.z;

    this.avatarGeometry = new THREE.SphereGeometry(1, 24, 16);
    this.avatarMaterial = new THREE.MeshStandardMaterial({
      color: config.avatarColor ?? 0xf1e7d4,
      emissive: config.avatarEmissive ?? 0x172320,
      emissiveIntensity: 0.28,
      roughness: 0.48,
      metalness: 0.06,
    });
    this.avatar = new THREE.Mesh(this.avatarGeometry, this.avatarMaterial);
    this.avatar.name = 'PlayerAvatar';
    this.avatar.scale.set(
      config.avatarWidth ?? 0.56,
      (config.height ?? 1.8) / 2,
      config.avatarDepth ?? 0.42,
    );
    this.avatar.castShadow = true;
    this.avatar.receiveShadow = false;
    world.group.add(this.avatar);

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handleWheel = this.handleWheel.bind(this);
    this.handlePointerLockChange = this.handlePointerLockChange.bind(this);
    this.handlePointerLockError = this.handlePointerLockError.bind(this);
    this.handleBlur = this.handleBlur.bind(this);

    this.syncCamera();
    this.syncAvatar();

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    window.addEventListener('wheel', this.handleWheel, { passive: false });
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);
  }

  requestPointerLock() {
    if (typeof this.domElement.requestPointerLock !== 'function') return;
    try {
      const result = this.domElement.requestPointerLock();
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch {
      // Pointer lock can be denied by browser policy; the click prompt remains available.
    }
  }

  releasePointerLock() {
    this.isLocked = false;
    this.keys.clear();
    this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
    this.onLockChange(false);
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
  }

  handleKeyDown(event) {
    if (event.code === 'Escape') {
      event.preventDefault();
      this.releasePointerLock();
      return;
    }
    if (!MOVEMENT_KEYS.has(event.code)) return;
    if (!this.isLocked) return;
    event.preventDefault();

    if (event.code === 'Space') {
      if (event.repeat || !this.isLocked) return;
      this.keys.add(event.code);

      const now = performance.now();
      const doubleTapWindow = this.config.doubleTapWindowMs ?? 340;
      if (now - this.lastSpaceTapAt <= doubleTapWindow) {
        this.setFlying(!this.isFlying);
        // Require a fresh pair of presses after each toggle; a third quick tap
        // should not immediately cancel the takeoff.
        this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
      } else {
        this.lastSpaceTapAt = now;
      }
      return;
    }

    this.keys.add(event.code);
  }

  handleKeyUp(event) {
    if (MOVEMENT_KEYS.has(event.code)) this.keys.delete(event.code);
  }

  handleMouseMove(event) {
    if (!this.isLocked) return;
    this.yaw += event.movementX * this.config.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + event.movementY * this.config.mouseSensitivity,
      this.config.minPitch ?? 0.08,
      this.config.maxPitch ?? 1.12,
    );
  }

  handleWheel(event) {
    if (!this.isLocked) return;
    event.preventDefault();
    const zoomStep = this.config.zoomStep ?? 0.9;
    this.cameraDistance = THREE.MathUtils.clamp(
      this.cameraDistance + Math.sign(event.deltaY) * zoomStep,
      this.config.minCameraDistance ?? 5,
      this.config.maxCameraDistance ?? 17,
    );
  }

  handlePointerLockChange() {
    this.isLocked = document.pointerLockElement === this.domElement;
    if (!this.isLocked) {
      this.keys.clear();
      this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
    }
    this.onLockChange(this.isLocked);
  }

  handlePointerLockError() {
    this.isLocked = false;
    this.keys.clear();
    this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
    this.onLockChange(false);
  }

  handleBlur() {
    this.keys.clear();
    this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
  }

  setFlying(flying) {
    if (this.isFlying === flying) return;
    this.isFlying = flying;
    if (flying) {
      // The double-tap gives a small automatic lift, so takeoff works even
      // when the second press is released before the next rendered frame.
      this.velocityY = Math.max(this.velocityY, this.config.flightTakeoffSpeed ?? 14);
    } else {
      this.velocityY = 0;
    }
    this.onFlightChange(this.isFlying);
  }

  update(deltaSeconds) {
    const dt = Math.min(deltaSeconds, 0.05);

    if (this.isLocked) {
      const forwardInput = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
      const strafeInput = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
      const inputLength = Math.hypot(forwardInput, strafeInput);

      if (inputLength > 0) {
        const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
        const speed = sprinting ? this.config.sprintSpeed : this.config.walkSpeed;
        const normalizedForward = forwardInput / inputLength;
        const normalizedStrafe = strafeInput / inputLength;
        const deltaX = (
          Math.cos(this.yaw) * normalizedStrafe
          - Math.sin(this.yaw) * normalizedForward
        ) * speed * dt;
        const deltaZ = (
          -Math.sin(this.yaw) * normalizedStrafe
          - Math.cos(this.yaw) * normalizedForward
        ) * speed * dt;

        const afterX = this.world.resolveHorizontalPosition(
          this.position.x + deltaX,
          this.position.z,
          this.config.radius,
          this.position.y,
          this.config.height,
        );
        this.position.x = afterX.x;

        const afterZ = this.world.resolveHorizontalPosition(
          this.position.x,
          this.position.z + deltaZ,
          this.config.radius,
          this.position.y,
          this.config.height,
        );
        this.position.z = afterZ.z;

        const targetFacingYaw = Math.atan2(-deltaX, -deltaZ);
        const angleDifference = Math.atan2(
          Math.sin(targetFacingYaw - this.facingYaw),
          Math.cos(targetFacingYaw - this.facingYaw),
        );
        this.facingYaw += angleDifference * (1 - Math.exp(-12 * dt));
      }

      if (this.isFlying) {
        const descending = this.keys.has('ControlLeft') || this.keys.has('ControlRight');
        const verticalInput = Number(this.keys.has('Space')) - Number(descending);
        const targetVelocity = verticalInput * (this.config.flightSpeed ?? 24);
        const response = this.config.flightAcceleration ?? 8;
        const blend = 1 - Math.exp(-response * dt);
        this.velocityY += (targetVelocity - this.velocityY) * blend;
        this.position.y += this.velocityY * dt;
      } else {
        this.velocityY -= this.config.gravity * dt;
        this.position.y += this.velocityY * dt;
      }

      const floorHeight = this.world.getFloorHeightAt(this.position.x, this.position.z);
      if (floorHeight !== null) {
        this.lastSafeX = this.position.x;
        this.lastSafeZ = this.position.z;
        if (this.position.y <= floorHeight) {
          this.position.y = floorHeight;
          this.velocityY = 0;
          if (this.isFlying) this.setFlying(false);
        }
      }

      const fallLimit = this.config.fallLimit ?? -120;
      if (this.position.y < fallLimit) {
        this.position.set(this.lastSafeX, this.world.config.floorHeight, this.lastSafeZ);
        this.velocityY = 0;
        if (this.isFlying) this.setFlying(false);
      }
    }

    this.syncAvatar();
    this.syncCamera();
  }

  syncAvatar() {
    this.avatar.position.set(
      this.position.x,
      this.position.y + (this.config.height ?? 1.8) / 2,
      this.position.z,
    );
    this.avatar.rotation.y = this.facingYaw;
  }

  syncCamera() {
    const targetHeight = this.config.cameraTargetHeight ?? 1.05;
    const targetX = this.position.x;
    const targetY = this.position.y + targetHeight;
    const targetZ = this.position.z;
    let distance = this.cameraDistance;

    if (typeof this.world.resolveHorizontalPosition === 'function') {
      for (let pass = 0; pass < 6; pass += 1) {
        const horizontalDistance = distance * Math.cos(this.pitch);
        const cameraX = targetX + Math.sin(this.yaw) * horizontalDistance;
        const cameraY = targetY + distance * Math.sin(this.pitch);
        const cameraZ = targetZ + Math.cos(this.yaw) * horizontalDistance;
        const resolved = this.world.resolveHorizontalPosition(
          cameraX,
          cameraZ,
          0.35,
          cameraY - 0.4,
          0.8,
        );
        const blocked = Math.hypot(resolved.x - cameraX, resolved.z - cameraZ) > 0.02;
        if (!blocked) break;
        distance *= 0.72;
      }
    }

    const horizontalDistance = distance * Math.cos(this.pitch);
    this.camera.position.set(
      targetX + Math.sin(this.yaw) * horizontalDistance,
      targetY + distance * Math.sin(this.pitch),
      targetZ + Math.cos(this.yaw) * horizontalDistance,
    );
    this.camera.lookAt(targetX, targetY, targetZ);
  }

  dispose() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    window.removeEventListener('wheel', this.handleWheel);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);
    this.world.group.remove(this.avatar);
    this.avatarGeometry.dispose();
    this.avatarMaterial.dispose();
  }
}
