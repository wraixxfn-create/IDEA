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
    this.isDashing = false;
    this.dashRemaining = 0;
    this.dashCooldownRemaining = 0;
    this.dashDirection = new THREE.Vector2(0, -1);
    this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
    this.onLockChange = () => {};
    this.onFlightChange = () => {};
    this.onDashChange = () => {};

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
    this.avatar.castShadow = false;
    this.avatar.receiveShadow = false;
    world.group.add(this.avatar);

    this.dashEffectRemaining = 0;
    this.dashTrailMaterial = new THREE.MeshBasicMaterial({
      color: 0x9cf8ea,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    this.dashTrail = new THREE.Mesh(this.avatarGeometry, this.dashTrailMaterial);
    this.dashTrail.name = 'PlayerDashAfterimage';
    this.dashTrail.scale.set(
      (config.avatarWidth ?? 0.56) * 0.9,
      (config.height ?? 1.8) * 0.27,
      (config.avatarDepth ?? 0.42) * 0.9,
    );
    this.dashTrail.visible = false;
    world.group.add(this.dashTrail);

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
    this.stopDash();
    this.onLockChange(false);
    if (document.pointerLockElement === this.domElement) document.exitPointerLock();
  }

  stopDash() {
    const wasDashing = this.isDashing;
    this.isDashing = false;
    this.dashRemaining = 0;
    if (wasDashing) this.onDashChange(false);
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

    if (event.code === 'ShiftLeft' || event.code === 'ShiftRight') {
      this.keys.add(event.code);
      if (!event.repeat) this.startDash();
      return;
    }

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

  getInputDirection() {
    const forwardInput = Number(this.keys.has('KeyW')) - Number(this.keys.has('KeyS'));
    const strafeInput = Number(this.keys.has('KeyD')) - Number(this.keys.has('KeyA'));
    const inputLength = Math.hypot(forwardInput, strafeInput);
    if (inputLength === 0) return { x: 0, z: 0, inputLength: 0 };

    const forward = forwardInput / inputLength;
    const strafe = strafeInput / inputLength;
    return {
      x: Math.cos(this.yaw) * strafe - Math.sin(this.yaw) * forward,
      z: -Math.sin(this.yaw) * strafe - Math.cos(this.yaw) * forward,
      inputLength,
    };
  }

  startDash() {
    if (!this.isLocked || this.dashRemaining > 0 || this.dashCooldownRemaining > 0) return false;

    const inputDirection = this.getInputDirection();
    if (inputDirection.inputLength > 0) {
      this.dashDirection.set(inputDirection.x, inputDirection.z).normalize();
    } else {
      // A stationary dash uses the avatar's last facing direction.
      this.dashDirection.set(-Math.sin(this.facingYaw), -Math.cos(this.facingYaw));
    }

    this.dashRemaining = this.config.dashDuration ?? 0.22;
    this.dashCooldownRemaining = this.config.dashCooldown ?? 0.65;
    this.dashEffectRemaining = Math.max(0.24, this.dashRemaining);
    this.isDashing = true;
    this.onDashChange(true);
    return true;
  }

  handleMouseMove(event) {
    if (!this.isLocked) return;
    // Invert the horizontal orbit to match the usual mouse-look direction.
    this.yaw -= event.movementX * this.config.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + event.movementY * this.config.mouseSensitivity,
      this.config.minPitch ?? (-Math.PI / 2 + 0.025),
      this.config.maxPitch ?? (Math.PI / 2 - 0.025),
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
      this.stopDash();
    }
    this.onLockChange(this.isLocked);
  }

  handlePointerLockError() {
    this.isLocked = false;
    this.keys.clear();
    this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
    this.stopDash();
    this.onLockChange(false);
  }

  handleBlur() {
    this.keys.clear();
    this.lastSpaceTapAt = Number.NEGATIVE_INFINITY;
    this.stopDash();
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
    this.dashEffectRemaining = Math.max(0, this.dashEffectRemaining - dt);

    if (this.isLocked) {
      this.dashCooldownRemaining = Math.max(0, this.dashCooldownRemaining - dt);
      const inputDirection = this.getInputDirection();

      if (inputDirection.inputLength > 0) {
        const targetFacingYaw = Math.atan2(-inputDirection.x, -inputDirection.z);
        const angleDifference = Math.atan2(
          Math.sin(targetFacingYaw - this.facingYaw),
          Math.cos(targetFacingYaw - this.facingYaw),
        );
        this.facingYaw += angleDifference * (1 - Math.exp(-12 * dt));
      }

      let deltaX = 0;
      let deltaZ = 0;
      const dashStep = Math.min(dt, this.dashRemaining);
      if (dashStep > 0) {
        const dashSpeed = this.config.dashSpeed ?? 42;
        deltaX += this.dashDirection.x * dashSpeed * dashStep;
        deltaZ += this.dashDirection.y * dashSpeed * dashStep;
        this.dashRemaining -= dashStep;
        if (this.dashRemaining <= 1e-5) {
          this.dashRemaining = 0;
          if (this.isDashing) {
            this.isDashing = false;
            this.onDashChange(false);
          }
        }
      }

      // Shift is a single burst, never a faster walk while the key is held.
      const walkingTime = Math.max(0, dt - dashStep);
      if (inputDirection.inputLength > 0 && walkingTime > 0) {
        const walkSpeed = this.config.walkSpeed ?? 10;
        deltaX += inputDirection.x * walkSpeed * walkingTime;
        deltaZ += inputDirection.z * walkSpeed * walkingTime;
      }

      if (deltaX !== 0 || deltaZ !== 0) this.moveHorizontally(deltaX, deltaZ);

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
      if (floorHeight !== null && this.position.y <= floorHeight) {
        this.position.y = floorHeight;
        this.velocityY = 0;
        if (this.isFlying) this.setFlying(false);
      }
    }

    this.syncAvatar();
    this.syncCamera();
  }

  moveHorizontally(deltaX, deltaZ) {
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
  }

  syncAvatar() {
    this.avatar.position.set(
      this.position.x,
      this.position.y + (this.config.height ?? 1.8) / 2,
      this.position.z,
    );
    this.avatar.rotation.y = this.facingYaw;
    this.avatarMaterial.emissiveIntensity = this.isDashing ? 0.9 : 0.28;

    if (this.dashEffectRemaining > 0) {
      const duration = Math.max(0.24, this.config.dashDuration ?? 0.22);
      const fade = THREE.MathUtils.clamp(this.dashEffectRemaining / duration, 0, 1);
      this.dashTrail.visible = true;
      this.dashTrail.position.set(
        this.position.x - this.dashDirection.x * 0.72,
        this.position.y + (this.config.height ?? 1.8) * 0.5,
        this.position.z - this.dashDirection.y * 0.72,
      );
      this.dashTrail.rotation.y = this.facingYaw;
      this.dashTrailMaterial.opacity = fade * 0.34;
    } else {
      this.dashTrail.visible = false;
    }
  }

  syncCamera() {
    const targetHeight = this.config.cameraTargetHeight ?? 1.05;
    const horizontalDistance = this.cameraDistance * Math.cos(this.pitch);
    const verticalDistance = this.cameraDistance * Math.sin(this.pitch);
    const targetX = this.position.x;
    const targetY = this.position.y + targetHeight;
    const targetZ = this.position.z;

    this.camera.position.set(
      targetX + Math.sin(this.yaw) * horizontalDistance,
      targetY + verticalDistance,
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
    this.world.group.remove(this.dashTrail);
    this.avatarGeometry.dispose();
    this.avatarMaterial.dispose();
    this.dashTrailMaterial.dispose();
  }
}
