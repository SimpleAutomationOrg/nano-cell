// A cell is a ROBOT with an APPLICATION set up on it.
//
//   cell_<arm>/robot.json                 the design of the cell: the arm (and
//                                         arm/, its meshes), its mount, the table, the
//                                         guard, the flange stack, cameras, IO
//   applications/<name>/application.json  the job and its environment: the
//                                         grippers, the tool rack, fixtures,
//                                         parts — plus its tasks/ and print/
//
// Everything in an application is in the table frame, so the same
// application composes onto another robot unchanged. What it needs FROM a
// robot is checked here, with an error that names the missing thing.
// Pure (no fetch, no three.js): the page and the tests share it.

// a robot is a folder in the repository root, named after it (cell_fr3/)
export const robotDir = name => `${name}/`;
export const applicationDir = name => `applications/${name}/`;

// mesh paths are written relative to the file that names them; the
// composed cell carries them relative to the repository root
const rooted = (items, dir) => (items ?? []).map(it => ({
  ...it,
  ...(it.mesh ? { mesh: dir + it.mesh } : {}),
  ...(it.collision_mesh ? { collision_mesh: dir + it.collision_mesh } : {}),
}));

/**
 * The cell the viewer, the planner and the physics work on: `robot` with
 * `application` set up on it. Throws when the robot cannot run the
 * application.
 */
export function composeCell(robot, application) {
  const app = application.id ?? application.name, rob = robot.id ?? robot.name;
  const rdir = robot.dir ?? robotDir(rob), adir = application.dir ?? applicationDir(app);
  const fail = msg => { throw new Error(`application '${app}' on robot '${rob}': ${msg}`); };

  const tools = [...rooted(robot.tools, rdir), ...rooted(application.tools, adir)];
  const fixtures = rooted(application.fixtures, adir);
  const parts = rooted(application.parts, adir);

  const seen = new Set();
  for (const it of [...tools, ...fixtures, ...parts, ...(robot.flange_stack ?? [])]) {
    if (seen.has(it.id)) fail(`the id '${it.id}' is used twice`);
    seen.add(it.id);
  }

  // what the grippers need from the robot: the IO lines they switch
  const io = new Map((robot.io ?? []).map(s => [s.name, s.kind]));
  const need = (tool, name, kind) => {
    if (name == null) return;
    if (io.get(name) !== kind) fail(`gripper '${tool}' needs the ${kind} '${name}', which the robot does not have`);
  };
  for (const t of application.tools ?? []) {
    need(t.id, t.vacuum?.output, 'output');
    need(t.id, t.vacuum?.held_input, 'input');
  }

  // joint-space values belong to one robot; on any other they are absent
  // and have to be taught again
  const taught = application.taught_on?.[rob] ?? {};
  const stands = (application.tool_rack?.stands ?? []).map(s => {
    if (s.tool_id && !tools.some(t => t.id === s.tool_id)) fail(`${s.name} holds the unknown gripper '${s.tool_id}'`);
    if (s.fixture_id && !fixtures.some(f => f.id === s.fixture_id)) fail(`${s.name} stands on the unknown fixture '${s.fixture_id}'`);
    return { ...s, ...(taught.stands?.[s.name] ?? {}) };
  });
  if (stands.length && !robot.changer) fail('it has a tool rack, but the robot has no tool changer');
  if (application.mounted_tool && !tools.some(t => t.id === application.mounted_tool)) {
    fail(`mounted_tool '${application.mounted_tool}' is not one of its grippers`);
  }

  return {
    name: `${application.name ?? app} on ${robot.name ?? rob}`,
    application: app,
    robot: rob,
    robot_dir: rdir,
    units: robot.units,
    conventions: { ...application.conventions, ...robot.conventions },
    arm: robot.arm,
    table: robot.table,
    guard: robot.guard,
    flange_stack: rooted(robot.flange_stack, rdir),
    tools,
    changer: {
      ...robot.changer,
      ...(taught.unlock_interlock ? { unlock_interlock: taught.unlock_interlock } : {}),
      stands,
    },
    mounted_tool: application.mounted_tool,
    demo_start_tool: application.demo_start_tool,
    fixtures,
    parts,
    unplaced_parts: application.unplaced_parts ?? [],
    cameras: robot.cameras,
    io: robot.io,
  };
}

/**
 * Read an application and the robot it is set up on (or `robotName`, to
 * try it on another one) and compose them. `readJson(path)` gets a path
 * relative to the repository root.
 */
export async function loadCell(readJson, applicationName, robotName = null) {
  const application = await readJson(applicationDir(applicationName) + 'application.json');
  const rob = robotName ?? application.robot;
  const robot = await readJson(robotDir(rob) + 'robot.json');
  return composeCell({ ...robot, id: rob }, { ...application, id: applicationName });
}
