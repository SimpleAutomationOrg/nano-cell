// Loops of the case-assembly application: which steps make up one cycle
// of work, in the order they run. A step is a file in steps/, named here
// without its extension.

export interface Loop {
  /** What the loop is called in the viewer. */
  name: string;
  /** The steps of one cycle, in order. */
  steps: string[];
}

export const loops: Record<string, Loop> = {
  // One case, built up in the holder pocket from the bottom: the front
  // case goes in first, face down, and the back case closes it.
  'assemble-case': {
    name: 'Assemble one case',
    steps: [
      'pick-place-case',        // front case from the north stack into the holder
      // button into the front case      — no step yet
      // PCB into the front case         — no step yet
      'pick-place-back-case',   // back case from the south stack onto it
      // screws from the feeder          — no step yet
    ],
  },
};
