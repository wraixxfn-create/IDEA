import * as THREE from 'three';

const MOVEMENT_KEYS = new Set([
  'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft', 'ShiftRight',
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
    this.pitch = 0;
    this.keys = new Set();
    this.isLocked = false;
    this.onLockChange = () => {};

    this.camera.rotation.order = 'YXZ';
    this.syncCamera();

    this.handleKeyDown = this.handleKeyDown.bind(this);
    this.handleKeyUp = this.handleKeyUp.bind(this);
    this.handleMouseMove = this.handleMouseMove.bind(this);
    this.handlePointerLockChange = this.handlePointerLockChange.bind(this);
    this.handlePointerLockError = this.handlePointerLockError.bind(this);
    this.handleBlur = this.handleBlur.bind(this);

    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
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

  handleKeyDown(event) {
    if (MOVEMENT_KEYS.has(event.code)) {
      event.preventDefault();
      this.keys.add(event.code);
    }
  }

  handleKeyUp(event) {
    if (MOVEMENT_KEYS.has(event.code)) this.keys.delete(event.code);
  }

  handleMouseMove(event) {
    if (!this.isLocked) return;
    this.yaw -= event.movementX * this.config.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - event.movementY * this.config.mouseSensitivity,
      -this.config.maxPitch,
      this.config.maxPitch,
    );
  }

  handlePointerLockChange() {
    this.isLocked = document.pointerLockElement === this.domElement;
    if (!this.isLocked) this.keys.clear();
    this.onLockChange(this.isLocked);
  }

  handlePointerLockError() {
    this.isLocked = false;
    this.keys.clear();
    this.onLockChange(false);
  }

  handleBlur() {
    this.keys.clear();
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
        );
        this.position.x = afterX.x;

        const afterZ = this.world.resolveHorizontalPosition(
          this.position.x,
          this.position.z + deltaZ,
          this.config.radius,
        );
        this.position.z = afterZ.z;
      }

      this.velocityY -= this.config.gravity * dt;
      this.position.y += this.velocityY * dt;
      const floorHeight = this.world.getFloorHeightAt(this.position.x, this.position.z);
      if (floorHeight !== null && this.position.y <= floorHeight) {
        this.position.y = floorHeight;
        this.velocityY = 0;
      }
    }

    this.syncCamera();
  }

  syncCamera() {
    this.camera.position.set(
      this.position.x,
      this.position.y + this.config.eyeHeight,
      this.position.z,
    );
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  dispose() {
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    document.removeEventListener('mousemove', this.handleMouseMove);
    document.removeEventListener('pointerlockchange', this.handlePointerLockChange);
    document.removeEventListener('pointerlockerror', this.handlePointerLockError);
  }
}
