// Loops of the case-assembly application: which steps make up one cycle
// of work, in the order they run. A step is a file in steps/, named here
// without its extension. Steps listed in no loop still exist and can be
// run on their own (a fallback, a demo).
//
// The viewer rewrites the `steps` lists when steps are dragged in its
// panel: keep comments outside those lists.

export interface Loop {
  /** What the loop is called in the viewer. */
  name: string;
  /** The steps of one cycle, in order. */
  steps: string[];
}

export const loops: Record<string, Loop> = {
  // One case, built up in the holder pocket from the bottom: the front
  // case goes in first, face down, and the back case closes it.
  // Still to come, in their places: the button and the PCB into the front
  // case (before the back case), and the screws from the feeder (last).
  'assemble-case': {
    name: 'Assemble one case',
    steps: [
      'pick-place-case',
      'pick-place-back-case',
    ],
  },
};
