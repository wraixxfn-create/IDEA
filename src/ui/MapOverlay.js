/**
 * The world map overlay (M): when it is visible and what it does to the input.
 *
 * The map used to behave like a pause screen. Opening it released the pointer
 * lock, and closing it tried to take the lock back from the very keypress that
 * closed it. Two things went wrong with that:
 *
 *  1. The lock is granted a frame or two *after* the keypress, so every
 *     movement key pressed in that window was dropped, and a key that was
 *     already held down (the W the player was walking with) was cleared when
 *     the lock was released and never re-registered. The explorer stood still
 *     until the player let go and pressed W again.
 *  2. Everything the player typed while the map was up — a glance at the map
 *     should not cost the controls — was thrown away.
 *
 * The overlay is therefore a *true overlay*: it never touches the pointer lock
 * and never clears the key state. The keyboard and the mouse keep driving the
 * world while the map is open, and closing it needs no re-arming at all. The
 * only lock request left is a fallback for the case where the browser dropped
 * the lock on its own (Esc, tab switch) while the map was up.
 */
export class MapOverlay {
  constructor({ overlay = null, player = null, onChange = () => {}, onOpen = () => {} } = {}) {
    this.overlay = overlay;
    this.player = player;
    this.onChange = onChange;
    this.onOpen = onOpen;
    this.isOpen = false;
    // Whether the explorer was actually playing when the map was opened, so
    // the fallback lock request never drags a paused player back into the game.
    this.wasPlaying = false;
    this.opens = 0;
    this.closes = 0;
    this.resumes = 0;
  }

  setVisible(visible) {
    if (!this.overlay) return;
    this.overlay.classList.toggle('is-hidden', !visible);
    this.overlay.setAttribute('aria-hidden', String(!visible));
  }

  /** Shows the map. The pointer lock and the pressed keys are left alone. */
  open() {
    if (this.isOpen) return false;
    this.isOpen = true;
    this.wasPlaying = Boolean(this.player?.isLocked);
    this.setVisible(true);
    this.opens += 1;
    this.onOpen(this);
    this.onChange(this);
    return true;
  }

  /**
   * Hides the map. `resume: false` is used by Esc, which the browser answers
   * by dropping the pointer lock itself: there the pause menu is the right
   * place to land, not a hidden lock request.
   */
  close({ resume = true } = {}) {
    if (!this.isOpen) return false;
    this.isOpen = false;
    // Only ever a fallback: if the pointer is still locked there is nothing
    // to restore, which is exactly why the controls never go dead now.
    const shouldResume = Boolean(resume && this.wasPlaying && !this.player?.isLocked);
    this.wasPlaying = false;
    this.setVisible(false);
    this.closes += 1;
    if (shouldResume) {
      this.resumes += 1;
      this.player.requestPointerLock();
    }
    this.onChange(this);
    return true;
  }

  toggle(options) {
    return this.isOpen ? this.close(options) : this.open();
  }
}
