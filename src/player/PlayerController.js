import * as THREE from 'three';
import { CharacterRig, createCharacterEnvironment } from './CharacterRig.js';

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
    this.onViewModeChange = () => {};

    // 'third' orbits the explorer, 'first' puts the camera behind the visor.
    this.viewMode = config.initialViewMode === 'first' ? 'first' : 'third';
    this.eyeHeight = config.firstPersonEyeHeight ?? 1.63;
    this.bobPhase = 0;
    this.headBob = 0;
    // The ground contact is tracked explicitly so the explorer can follow a
    // slope downhill instead of leaving the terrain on every crest.
    this.isGrounded = true;

    // The avatar is a fully articulated character rig (see CharacterRig.js).
    // `this.avatar` points at its root so existing code and tests keep working.
    this.characterRig = new CharacterRig({
      ...(config.character ?? {}),
      accentColor: config.accentColor,
    });
    this.avatar = this.characterRig.root;
    this.characterRig.setFirstPerson(this.viewMode === 'first');
    world.group.add(this.avatar);

    // Animation inputs fed to the rig once per frame.
    this.groundHeight = world.config.floorHeight ?? 0;
    this.horizontalSpeed = 0;
    this.yawRate = 0;
    this.previousFacingYaw = this.facingYaw;
    this.environmentTexture = null;

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handlePointerLockChange = this.handlePointerLockChange.bind(this);
    this.handlePointerLockError = this.handlePointerLockError.bind(this);
    this.handleBlur = this.handleBlur.bind(this);

    this.syncCamera();
    this.syncAvatar();

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    document.addEventListener('mousemove', this.handleMouseMove);
    document.addEventListener('pointerlockchange', this.handlePointerLockChange);
    document.addEventListener('pointerlockerror', this.handlePointerLockError);
  }

  /** Bakes a small painted sky into a PMREM environment for the armour. */
  setRendererEnvironment(renderer, skyConfig = {}) {
    const texture = createCharacterEnvironment(renderer, skyConfig);
    if (!texture) return null;
    this.environmentTexture?.dispose?.();
    this.environmentTexture = texture;
    this.characterRig.setEnvironment(texture);
    return texture;
  }

  /** Shares the world's wind clock so the cloth moves with the forest. */
  setWind(uniforms) {
    this.characterRig.setWind(uniforms);
  }

  /** Recolours the sigils, thruster glow and cloth trim (sector theming). */
  setAccent(color) {
    this.characterRig.setAccent(color);
  }

  /** ---- View mode ------------------------------------------------------ */

  get isFirstPerson() {
    return this.viewMode === 'first';
  }

  /**
   * Switches between the orbiting follow camera and a camera mounted behind
   * the explorer's visor. In first person the body turns with the look
   * direction (the head *is* the camera) and the helmet is hidden.
   */
  setViewMode(mode) {
    const next = mode === 'first' ? 'first' : 'third';
    if (next === this.viewMode) return this.viewMode;
    this.viewMode = next;
    this.characterRig.setFirstPerson(next === 'first');
    if (next === 'first') {
      // Step straight into the body: no spin while the camera changes seat.
      this.facingYaw = this.yaw;
      this.previousFacingYaw = this.yaw;
      this.yawRate = 0;
    }
    this.headBob = 0;
    this.syncAvatar();
    this.syncCamera();
    this.onViewModeChange(this.viewMode);
    return this.viewMode;
  }

  toggleViewMode() {
    return this.setViewMode(this.isFirstPerson ? 'third' : 'first');
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
    this.isDashing = true;
    this.onDashChange(true);
    return true;
  }

  getMinimumPitch() {
    const configuredMinimum = this.config.minPitch ?? (-Math.PI / 2 + 0.025);
    // In first person the camera is the head: it can look all the way up
    // without any risk of dipping below the ground.
    if (this.viewMode === 'first') return configuredMinimum;
    const floorHeight = this.world.getFloorHeightAt?.(this.position.x, this.position.z)
      ?? this.world.config.floorHeight
      ?? 0;
    const targetY = this.position.y + (this.config.cameraTargetHeight ?? 1.05);
    // The pitch limiter only has to keep the lens out of the ground; the
    // boom sweep in `syncCamera` is what opens up the full clearance, so a
    // smaller margin here keeps low-angle shots available.
    const minimumCameraY = floorHeight
      + (this.config.cameraPitchFloorClearance ?? 0.35);
    const distance = Math.max(0.001, this.cameraDistance);
    const floorPitch = Math.asin(THREE.MathUtils.clamp(
      (minimumCameraY - targetY) / distance,
      -1,
      1,
    ));
    return Math.max(configuredMinimum, floorPitch);
  }

  handleMouseMove(event) {
    if (!this.isLocked) return;
    // Invert the horizontal orbit to match the usual mouse-look direction.
    this.yaw -= event.movementX * this.config.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch + event.movementY * this.config.mouseSensitivity,
      this.getMinimumPitch(),
      this.config.maxPitch ?? (Math.PI / 2 - 0.025),
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
    this.lastDelta = dt;
    const startX = this.position.x;
    const startZ = this.position.z;

    if (this.isLocked) {
      this.dashCooldownRemaining = Math.max(0, this.dashCooldownRemaining - dt);
      const inputDirection = this.getInputDirection();

      // In first person the body is carried by the look direction; in third
      // person it turns towards wherever the explorer is actually running.
      const targetFacingYaw = this.viewMode === 'first'
        ? this.yaw
        : (inputDirection.inputLength > 0
          ? Math.atan2(-inputDirection.x, -inputDirection.z)
          : null);
      if (targetFacingYaw !== null) {
        const angleDifference = Math.atan2(
          Math.sin(targetFacingYaw - this.facingYaw),
          Math.cos(targetFacingYaw - this.facingYaw),
        );
        this.facingYaw += angleDifference * (1 - Math.exp((this.viewMode === 'first' ? -24 : -12) * dt));
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
        this.isGrounded = false;
      } else {
        this.velocityY -= this.config.gravity * dt;
        this.position.y += this.velocityY * dt;
      }

      this.resolveGroundContact(Math.hypot(this.position.x - startX, this.position.z - startZ));
    }

    // Animation inputs for the character rig: measured ground speed (so the
    // gait matches the real, collision-resolved movement), turn rate for the
    // banking, and the terrain height for the contact shadow.
    if (dt > 0) {
      this.horizontalSpeed = Math.hypot(this.position.x - startX, this.position.z - startZ) / dt;
      const yawDelta = Math.atan2(
        Math.sin(this.facingYaw - this.previousFacingYaw),
        Math.cos(this.facingYaw - this.previousFacingYaw),
      );
      this.yawRate = yawDelta / dt;
    }
    this.previousFacingYaw = this.facingYaw;
    this.groundHeight = this.world.getFloorHeightAt(this.position.x, this.position.z);
    this.updateHeadBob(dt);

    this.syncAvatar();
    this.syncCamera();
  }

  /**
   * A small vertical head bob for the first-person camera. The phase advances
   * with the distance actually covered, so it matches the gait on any terrain
   * and stops dead when the explorer does.
   */
  updateHeadBob(dt) {
    if (this.viewMode !== 'first') {
      this.headBob = 0;
      return;
    }
    const walkSpeed = this.config.walkSpeed ?? 10;
    const stride = THREE.MathUtils.clamp(this.horizontalSpeed / Math.max(1e-3, walkSpeed), 0, 1.3);
    this.bobPhase += this.horizontalSpeed * dt * 0.55;
    const moving = this.isGrounded && !this.isFlying ? stride : 0;
    const target = Math.sin(this.bobPhase * 2) * (this.config.firstPersonBob ?? 0.042) * moving;
    this.headBob += (target - this.headBob) * (1 - Math.exp(-11 * dt));
  }

  /**
   * Keeps the explorer on the terrain surface.
   *
   * Walking *into* a rise lifts the explorer onto it; walking *off* a crest
   * snaps back down as long as the drop is within one stride, so rolling
   * ground is followed smoothly instead of producing a fall, a landing squash
   * and a stutter on every bump. Anything steeper than a stride is a real
   * drop, and gravity takes over.
   */
  resolveGroundContact(travelled = 0) {
    const floorHeight = this.world.getFloorHeightAt(this.position.x, this.position.z);
    if (floorHeight === null || floorHeight === undefined) {
      this.isGrounded = false;
      return;
    }

    if (this.position.y <= floorHeight) {
      this.position.y = floorHeight;
      this.velocityY = 0;
      this.isGrounded = true;
      if (this.isFlying) this.setFlying(false);
      return;
    }

    if (this.isFlying || !this.isGrounded) {
      this.isGrounded = false;
      return;
    }

    const snapDistance = Math.max(
      this.config.groundSnapDistance ?? 0.5,
      travelled * (this.config.groundSnapSlope ?? 1.6),
    );
    if (this.position.y - floorHeight <= snapDistance) {
      this.position.y = floorHeight;
      this.velocityY = 0;
      this.isGrounded = true;
      return;
    }

    this.isGrounded = false;
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
    const floorHeight = this.groundHeight;
    const grounded = this.isFlying ? false : (this.isGrounded || (
      floorHeight === null || floorHeight === undefined
        ? this.position.y <= (this.world.config.floorHeight ?? 0) + 1e-3
        : this.position.y <= floorHeight + 1e-3));

    this.characterRig.update(this.lastDelta ?? 1 / 60, {
      position: this.position,
      facingYaw: this.facingYaw,
      speed: this.horizontalSpeed,
      verticalVelocity: this.velocityY,
      yawRate: this.yawRate,
      isFlying: this.isFlying,
      isDashing: this.isDashing,
      grounded,
      groundHeight: floorHeight,
    });
  }

  syncCamera() {
    this.pitch = THREE.MathUtils.clamp(
      this.pitch,
      this.getMinimumPitch(),
      this.config.maxPitch ?? (Math.PI / 2 - 0.025),
    );
    if (this.viewMode === 'first') {
      this.syncFirstPersonCamera();
      return;
    }

    const targetHeight = this.config.cameraTargetHeight ?? 1.05;
    const horizontalDistance = this.cameraDistance * Math.cos(this.pitch);
    const verticalDistance = this.cameraDistance * Math.sin(this.pitch);
    const targetX = this.position.x;
    const targetY = this.position.y + targetHeight;
    const targetZ = this.position.z;

    const cameraX = targetX + Math.sin(this.yaw) * horizontalDistance;
    const cameraZ = targetZ + Math.cos(this.yaw) * horizontalDistance;
    let cameraY = targetY + verticalDistance;

    // On the forest relief the boom can tunnel through a bank between the
    // explorer and the lens, so the whole segment is tested, not just its
    // end point: for each sample the camera is raised until the straight
    // line target -> camera clears the ground by `cameraFloorClearance`.
    const clearance = this.config.cameraFloorClearance ?? 0.24;
    const samples = this.config.cameraClearanceSamples ?? 5;
    for (let step = 1; step <= samples; step += 1) {
      const t = step / samples;
      const ground = this.world.getFloorHeightAt?.(
        targetX + (cameraX - targetX) * t,
        targetZ + (cameraZ - targetZ) * t,
      );
      if (ground === null || ground === undefined) continue;
      // Hug the ground near the explorer and open up towards the lens.
      const required = targetY + (ground + clearance * t - targetY) / t;
      if (required > cameraY) cameraY = required;
    }

    this.camera.position.set(cameraX, cameraY, cameraZ);
    this.camera.lookAt(targetX, targetY, targetZ);
  }

  /** The camera rides behind the visor, aimed along the mouse look. */
  syncFirstPersonCamera() {
    // The lens sits just in front of the chest rather than inside the neck,
    // so looking down shows the explorer's own torso and boots instead of
    // the inside of its shoulders. The body carries it, hence `facingYaw`.
    const reach = this.config.firstPersonEyeForward ?? 0.34;
    const eyeX = this.position.x - Math.sin(this.facingYaw) * reach;
    const eyeY = this.position.y + this.eyeHeight + this.headBob;
    const eyeZ = this.position.z - Math.cos(this.facingYaw) * reach;
    const cosPitch = Math.cos(this.pitch);
    this.camera.position.set(eyeX, eyeY, eyeZ);
    this.camera.lookAt(
      eyeX - Math.sin(this.yaw) * cosPitch,
      eyeY - Math.sin(this.pitch),
      eyeZ - Math.cos(this.yaw) * cosPitch,
    );
  }

  dispose() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);
    this.world.group.remove(this.avatar);
    this.characterRig.dispose();
    this.environmentTexture?.dispose?.();
  }
}
