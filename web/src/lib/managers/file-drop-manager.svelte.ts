// custom: whether files from the desktop are currently dragged over the window.
// Counts dragenter/dragleave (they fire for every element crossed), so the
// overlay can be click-through and drops reach the album drop targets below it.
class FileDropManager {
  #depth = 0;
  dragging = $state(false);

  enter() {
    this.#depth++;
    this.dragging = true;
  }

  leave() {
    this.#depth = Math.max(0, this.#depth - 1);
    if (this.#depth === 0) {
      this.dragging = false;
    }
  }

  reset() {
    this.#depth = 0;
    this.dragging = false;
  }
}

export const fileDropManager = new FileDropManager();
