export type ResourceMap = Record<string, number>;

export interface TaskUncertainty {
  enabled: boolean;
  mean: number;
  stdDev: number;
}

export interface TaskInfo {
  id: string;
  name: string;
  duration: number;
  resources: ResourceMap;
  predecessors: string[];
  uncertainty: TaskUncertainty;
}

export interface FailureRule {
  taskId: string;
  probability: number;
  enabled?: boolean;
}

export interface FailureCandidate {
  taskId: string;
  globalTaskId: string;
  taskName: string;
  planeId: number;
  probability: number;
  roll: number;
  start: number;
  end: number;
  triggered: boolean;
  iteration?: number;
}

export interface RescheduleSimulationResult {
  scheduled: Record<string, [number, number]>;
  makespan: number;
  actualMakespan: number;
  tasks: Record<string, Task>;
  history: { gen: number; bestMs: number }[];
  triggered: boolean;
  failureEvent: FailureCandidate | null;
  failureEvents: FailureCandidate[];
  candidateFailures: FailureCandidate[];
  replacementPlaneId?: number;
  replacementPlaneIds: number[];
  targetPlanes: number[];
  frozenTaskIds: string[];
  removedTaskIds: string[];
}

export class Task {
  id: string;
  plane_id: number;
  type: string;
  name: string;
  duration: number;
  resources: ResourceMap;
  predecessors: string[];
  uncertainty: TaskUncertainty;

  constructor(
    id: string,
    plane_id: number,
    type_code: string,
    name: string,
    duration: number,
    resources: ResourceMap,
    predecessors: string[],
    uncertainty?: TaskUncertainty,
  ) {
    this.id = id;
    this.plane_id = plane_id;
    this.type = type_code;
    this.name = name;
    this.duration = duration;
    this.resources = resources;
    this.predecessors = predecessors;
    this.uncertainty = uncertainty ?? { enabled: false, mean: duration, stdDev: 0 };
  }
}

type DurationMap = Record<string, number>;

function deterministicDuration(task: Task) {
  if (task.uncertainty?.enabled) {
    return Math.max(1, Math.round(task.uncertainty.mean));
  }
  return Math.max(1, Math.round(task.duration));
}

function sampleNormal(mean: number, stdDev: number) {
  if (stdDev === 0) return mean;
  const u1 = 1 - Math.random();
  const u2 = 1 - Math.random();
  const randStdNormal = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return mean + stdDev * randStdNormal;
}

function sampleDuration(task: Task) {
  if (task.uncertainty?.enabled) {
    return Math.max(1, Math.round(sampleNormal(task.uncertainty.mean, task.uncertainty.stdDev)));
  }
  return deterministicDuration(task);
}

function buildDurationMap(tasks: Record<string, Task>, resolver: (task: Task) => number) {
  const durations: DurationMap = {};
  Object.entries(tasks).forEach(([taskId, task]) => {
    durations[taskId] = resolver(task);
  });
  return durations;
}

export function ssgs_decode(
  priority_list: string[],
  tasks: Record<string, Task>,
  res_cap: ResourceMap,
  durations?: DurationMap,
  fixedSchedule: Record<string, [number, number]> = {},
  releaseTimes: Record<string, number> = {},
) {
  const scheduled: Record<string, [number, number]> = Object.fromEntries(
    Object.entries(fixedSchedule).map(([taskId, window]) => [taskId, [window[0], window[1]] as [number, number]]),
  );
  const priorityPositions = new Map(priority_list.map((taskId, index) => [taskId, index]));
  const effectiveDurations = durations ?? buildDurationMap(tasks, deterministicDuration);
  const resourceUsage: Record<string, number[]> = {};
  const successors: Record<string, string[]> = {};
  const remainingPredCount: Record<string, number> = {};
  const eligible: string[] = [];
  const resourceKeys = new Set<string>(Object.keys(res_cap));

  Object.entries(tasks).forEach(([taskId, task]) => {
    successors[taskId] = [];
    Object.keys(task.resources).forEach(resource => resourceKeys.add(resource));
  });

  resourceKeys.forEach(resource => {
    resourceUsage[resource] = [];
  });

  const ensureUsageLength = (resource: string, endExclusive: number) => {
    const usage = resourceUsage[resource] ?? (resourceUsage[resource] = []);
    while (usage.length < endExclusive) usage.push(0);
    return usage;
  };

  const reserveResources = (task: Task, start: number, end: number) => {
    for (const [resource, amount] of Object.entries(task.resources)) {
      const usage = ensureUsageLength(resource, end);
      for (let t = start; t < end; t++) {
        usage[t] = (usage[t] ?? 0) + amount;
      }
    }
  };

  Object.entries(tasks).forEach(([taskId, task]) => {
    task.predecessors.forEach(predecessor => {
      if (!successors[predecessor]) successors[predecessor] = [];
      successors[predecessor].push(taskId);
    });
  });

  Object.entries(scheduled).forEach(([taskId, [start, end]]) => {
    const task = tasks[taskId];
    if (!task) return;
    reserveResources(task, start, end);
  });

  Object.keys(tasks).forEach(taskId => {
    if (scheduled[taskId] !== undefined) return;
    let count = 0;
    for (const predecessor of tasks[taskId].predecessors) {
      if (scheduled[predecessor] === undefined) count++;
    }
    remainingPredCount[taskId] = count;
    if (count === 0) eligible.push(taskId);
  });

  while (eligible.length > 0) {
    let bestIndex = 0;
    let bestPosition = priorityPositions.get(eligible[0]) ?? Number.MAX_SAFE_INTEGER;
    for (let index = 1; index < eligible.length; index++) {
      const currentPosition = priorityPositions.get(eligible[index]) ?? Number.MAX_SAFE_INTEGER;
      if (currentPosition < bestPosition) {
        bestIndex = index;
        bestPosition = currentPosition;
      }
    }

    const targetTaskId = eligible.splice(bestIndex, 1)[0];
    const task = tasks[targetTaskId];
    const taskDuration = effectiveDurations[targetTaskId];

    if (Object.entries(task.resources).some(([resource, amount]) => amount > (res_cap[resource] ?? 0))) {
      break;
    }

    let est = Math.max(0, Math.round(releaseTimes[targetTaskId] ?? 0));
    for (const predecessor of task.predecessors) {
      const predecessorWindow = scheduled[predecessor];
      if (predecessorWindow) est = Math.max(est, predecessorWindow[1]);
    }

    let start_time = est;
    while (true) {
      let nextStart = start_time;
      const endTime = start_time + taskDuration;

      for (const [resource, amount] of Object.entries(task.resources)) {
        const usage = ensureUsageLength(resource, endTime);
        const capacity = res_cap[resource] ?? 0;

        for (let t = start_time; t < endTime; t++) {
          if ((usage[t] ?? 0) + amount > capacity) {
            let blockEnd = t + 1;
            while (blockEnd < usage.length && (usage[blockEnd] ?? 0) + amount > capacity) {
              blockEnd++;
            }
            if (blockEnd > nextStart) nextStart = blockEnd;
            break;
          }
        }
      }

      if (nextStart === start_time) break;
      start_time = nextStart;
    }

    const end_time = start_time + taskDuration;
    scheduled[targetTaskId] = [start_time, end_time];
    reserveResources(task, start_time, end_time);

    for (const successor of successors[targetTaskId] ?? []) {
      if (scheduled[successor] !== undefined) continue;
      remainingPredCount[successor] -= 1;
      if (remainingPredCount[successor] === 0) {
        eligible.push(successor);
      }
    }
  }

  const makespan = Math.max(0, ...Object.values(scheduled).map(value => value[1]));
  return { scheduled, makespan };
}

class SequenceEvaluator {
  tasks: Record<string, Task>;
  res_cap: ResourceMap;
  sampleCount: number;
  fixedSchedule: Record<string, [number, number]>;
  releaseTimes: Record<string, number>;
  deterministicOnly: boolean;

  constructor(
    tasks: Record<string, Task>,
    res_cap: ResourceMap,
    sampleCount = 100,
    fixedSchedule: Record<string, [number, number]> = {},
    releaseTimes: Record<string, number> = {},
  ) {
    this.tasks = tasks;
    this.res_cap = res_cap;
    this.sampleCount = Math.max(1, sampleCount);
    this.fixedSchedule = fixedSchedule;
    this.releaseTimes = releaseTimes;
    this.deterministicOnly = Object.values(tasks).every(
      task => !task.uncertainty?.enabled || task.uncertainty.stdDev === 0,
    );
  }

  evaluate(priorityList: string[]) {
    if (this.sampleCount === 1 || this.deterministicOnly) {
      return this.deterministicSchedule(priorityList).makespan;
    }
    let totalMakespan = 0;
    for (let i = 0; i < this.sampleCount; i++) {
      const durations = buildDurationMap(this.tasks, sampleDuration);
      totalMakespan += ssgs_decode(priorityList, this.tasks, this.res_cap, durations, this.fixedSchedule, this.releaseTimes).makespan;
    }
    return Number((totalMakespan / this.sampleCount).toFixed(2));
  }

  deterministicSchedule(priorityList: string[]) {
    const durations = buildDurationMap(this.tasks, deterministicDuration);
    return ssgs_decode(priorityList, this.tasks, this.res_cap, durations, this.fixedSchedule, this.releaseTimes);
  }
}

export class GeneticAlgorithm {
  tasks: Record<string, Task>;
  all_ids: string[];
  pop_size: number;
  gens: number;
  mutation_rate: number;
  evaluator: SequenceEvaluator;

  constructor(
    tasks: Record<string, Task>,
    all_ids: string[],
    res_cap: ResourceMap,
    pop_size = 30,
    gens = 50,
    sampleCount = 100,
    fixedSchedule: Record<string, [number, number]> = {},
    releaseTimes: Record<string, number> = {},
  ) {
    this.tasks = tasks;
    this.all_ids = all_ids;
    this.pop_size = pop_size;
    this.gens = gens;
    this.mutation_rate = 0.2;
    this.evaluator = new SequenceEvaluator(tasks, res_cap, sampleCount, fixedSchedule, releaseTimes);
  }

  init_population() {
    const population: string[][] = [];
    for (let i = 0; i < this.pop_size; i++) {
      const chromosome = [...this.all_ids];
      for (let j = chromosome.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [chromosome[j], chromosome[k]] = [chromosome[k], chromosome[j]];
      }
      population.push(chromosome);
    }
    return population;
  }

  selection(population: string[][], fitness: number[]) {
    const idx1 = Math.floor(Math.random() * population.length);
    const idx2 = Math.floor(Math.random() * population.length);
    return fitness[idx1] > fitness[idx2] ? population[idx1] : population[idx2];
  }

  crossover(parent1: string[], parent2: string[]) {
    const size = parent1.length;
    let a = Math.floor(Math.random() * size);
    let b = Math.floor(Math.random() * size);
    if (a > b) [a, b] = [b, a];

    const child = new Array<string | null>(size).fill(null);
    for (let i = a; i < b; i++) {
      child[i] = parent1[i];
    }

    const parent2Fill = parent2.filter(item => !child.includes(item));
    let fillIndex = 0;
    for (let i = 0; i < size; i++) {
      if (child[i] === null) {
        child[i] = parent2Fill[fillIndex++];
      }
    }
    return child as string[];
  }

  mutate(chromosome: string[]) {
    if (Math.random() < this.mutation_rate) {
      const idx1 = Math.floor(Math.random() * chromosome.length);
      const idx2 = Math.floor(Math.random() * chromosome.length);
      [chromosome[idx1], chromosome[idx2]] = [chromosome[idx2], chromosome[idx1]];
    }
    return chromosome;
  }

  async run(onProgress: (gen: number, bestMs: number) => void) {
    let population = this.init_population();
    let bestChromosome: string[] | null = null;
    let minMakespan = Infinity;
    const history: { gen: number; bestMs: number }[] = [];

    for (let generation = 0; generation < this.gens; generation++) {
      const makespans = population.map(individual => this.evaluator.evaluate(individual));
      const fitness = makespans.map(makespan => 1.0 / makespan);
      const currentMin = Math.min(...makespans);

      if (currentMin < minMakespan) {
        minMakespan = currentMin;
        bestChromosome = [...population[makespans.indexOf(currentMin)]];
      }

      history.push({ gen: generation + 1, bestMs: Number(minMakespan.toFixed(2)) });

      const newPopulation = [bestChromosome!];
      while (newPopulation.length < this.pop_size) {
        const parent1 = this.selection(population, fitness);
        const parent2 = this.selection(population, fitness);
        let child = this.crossover(parent1, parent2);
        child = this.mutate(child);
        newPopulation.push(child);
      }
      population = newPopulation;

      if (generation % 5 === 0 || generation === this.gens - 1) {
        onProgress(generation + 1, Number(minMakespan.toFixed(2)));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const { scheduled } = this.evaluator.deterministicSchedule(bestChromosome!);
    return { scheduled, makespan: Number(minMakespan.toFixed(2)), history };
  }
}

export class SimulatedAnnealing {
  tasks: Record<string, Task>;
  all_ids: string[];
  gens: number;
  evaluator: SequenceEvaluator;

  constructor(
    tasks: Record<string, Task>,
    all_ids: string[],
    res_cap: ResourceMap,
    gens = 100,
    sampleCount = 100,
    fixedSchedule: Record<string, [number, number]> = {},
    releaseTimes: Record<string, number> = {},
  ) {
    this.tasks = tasks;
    this.all_ids = all_ids;
    this.gens = gens;
    this.evaluator = new SequenceEvaluator(tasks, res_cap, sampleCount, fixedSchedule, releaseTimes);
  }

  async run(onProgress: (gen: number, bestMs: number) => void) {
    let currentChromosome = [...this.all_ids].sort(() => Math.random() - 0.5);
    let currentMakespan = this.evaluator.evaluate(currentChromosome);

    let bestChromosome = [...currentChromosome];
    let bestMakespan = currentMakespan;

    let temperature = 100;
    const coolingRate = 0.95;
    const history: { gen: number; bestMs: number }[] = [];

    for (let generation = 0; generation < this.gens; generation++) {
      const neighbor = [...currentChromosome];
      const idx1 = Math.floor(Math.random() * neighbor.length);
      const idx2 = Math.floor(Math.random() * neighbor.length);
      [neighbor[idx1], neighbor[idx2]] = [neighbor[idx2], neighbor[idx1]];

      const neighborMakespan = this.evaluator.evaluate(neighbor);

      if (neighborMakespan < currentMakespan || Math.random() < Math.exp((currentMakespan - neighborMakespan) / temperature)) {
        currentChromosome = neighbor;
        currentMakespan = neighborMakespan;
        if (currentMakespan < bestMakespan) {
          bestMakespan = currentMakespan;
          bestChromosome = [...currentChromosome];
        }
      }

      temperature *= coolingRate;
      history.push({ gen: generation + 1, bestMs: Number(bestMakespan.toFixed(2)) });

      if (generation % 5 === 0 || generation === this.gens - 1) {
        onProgress(generation + 1, Number(bestMakespan.toFixed(2)));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const { scheduled } = this.evaluator.deterministicSchedule(bestChromosome);
    return { scheduled, makespan: Number(bestMakespan.toFixed(2)), history };
  }
}

export interface RescheduleOptions {
  tasks: Record<string, Task>;
  workflow: TaskInfo[];
  numPlanes: number;
  resources: ResourceMap;
  algorithm: 'GA' | 'SA';
  popSize: number;
  gens: number;
  sampleCount: number;
  baseScheduled: Record<string, [number, number]>;
  baseMakespan?: number;
  targetPlanes: number[];
  failureRules: FailureRule[];
}

function calculateActualMakespan(schedule: Record<string, [number, number]>) {
  const windows = Object.values(schedule);
  return windows.length > 0 ? Math.max(...windows.map(([, end]) => end)) : 0;
}

function buildFailureCandidates(
  targetPlanes: number[],
  failureRules: FailureRule[],
  schedule: Record<string, [number, number]>,
  tasks: Record<string, Task>,
  iteration: number,
) {
  const candidates: FailureCandidate[] = [];
  const planesWithCandidates = new Set<number>();

  targetPlanes.forEach(planeId => {
    let planeHasCandidate = false;
    failureRules.forEach(rule => {
      const globalTaskId = `A${planeId}_${rule.taskId}`;
      const window = schedule[globalTaskId];
      const task = tasks[globalTaskId];
      if (!window || !task) return;

      planeHasCandidate = true;
      const roll = Math.random();
      candidates.push({
        taskId: rule.taskId,
        globalTaskId,
        taskName: task.name,
        planeId,
        probability: Number(rule.probability.toFixed(4)),
        roll: Number(roll.toFixed(4)),
        start: window[0],
        end: window[1],
        triggered: roll < rule.probability,
        iteration,
      });
    });

    if (planeHasCandidate) {
      planesWithCandidates.add(planeId);
    }
  });

  candidates.sort((left, right) => left.end - right.end || left.start - right.start || left.planeId - right.planeId || left.taskId.localeCompare(right.taskId));
  return { candidates, planesWithCandidates };
}

function buildRescheduleProblem(
  currentTasks: Record<string, Task>,
  workflow: TaskInfo[],
  currentSchedule: Record<string, [number, number]>,
  failedPlaneId: number,
  failureTime: number,
  replacementPlaneId: number,
) {
  const rescheduleTasks: Record<string, Task> = {};
  const rescheduleIds: string[] = [];
  const fixedSchedule: Record<string, [number, number]> = {};
  const releaseTimes: Record<string, number> = {};
  const frozenTaskIds: string[] = [];
  const removedTaskIds: string[] = [];

  Object.entries(currentTasks).forEach(([taskId, task]) => {
    const [start] = currentSchedule[taskId];
    if (start < failureTime) {
      rescheduleTasks[taskId] = task;
      fixedSchedule[taskId] = currentSchedule[taskId];
      frozenTaskIds.push(taskId);
      return;
    }

    if (task.plane_id === failedPlaneId) {
      removedTaskIds.push(taskId);
      return;
    }

    rescheduleTasks[taskId] = task;
    rescheduleIds.push(taskId);
    releaseTimes[taskId] = failureTime;
  });

  const replacementMap: Record<string, string> = {};
  workflow.forEach(task => {
    replacementMap[task.id] = `A${replacementPlaneId}_${task.id}`;
  });

  workflow.forEach(task => {
    const globalTaskId = replacementMap[task.id];
    const predecessors = task.predecessors.map(predecessor => replacementMap[predecessor]);
    const displayDuration = task.uncertainty.enabled ? task.uncertainty.mean : task.duration;
    rescheduleTasks[globalTaskId] = new Task(
      globalTaskId,
      replacementPlaneId,
      task.id,
      task.name,
      Math.max(1, Math.round(displayDuration)),
      task.resources,
      predecessors,
      task.uncertainty,
    );
    rescheduleIds.push(globalTaskId);
    releaseTimes[globalTaskId] = failureTime;
  });

  return {
    rescheduleTasks,
    rescheduleIds,
    fixedSchedule,
    releaseTimes,
    frozenTaskIds,
    removedTaskIds,
  };
}

export async function simulateReschedule(
  options: RescheduleOptions,
  onProgress: (gen: number, bestMs: number) => void = () => {},
): Promise<RescheduleSimulationResult> {
  const enabledRules = options.failureRules.filter(rule => (rule.enabled ?? true) && rule.probability > 0);
  if (enabledRules.length === 0) {
    throw new Error('请至少启用一个会触发换机的活动。');
  }

  const targetPlanes = Array.from(new Set(options.targetPlanes))
    .filter(planeId => planeId >= 1 && planeId <= options.numPlanes)
    .sort((left, right) => left - right);
  if (targetPlanes.length === 0) {
    throw new Error('请至少选择一架目标飞机。');
  }

  let currentTasks = options.tasks;
  let currentSchedule = options.baseScheduled;
  let remainingTargetPlanes = [...targetPlanes];
  let nextPlaneId = Math.max(options.numPlanes, ...Object.values(options.tasks).map(task => task.plane_id));
  let finalAverageMakespan = options.baseMakespan ?? calculateActualMakespan(currentSchedule);
  const failureEvents: FailureCandidate[] = [];
  const candidateFailures: FailureCandidate[] = [];
  const replacementPlaneIds: number[] = [];
  const frozenTaskIds = new Set<string>();
  const removedTaskIds = new Set<string>();
  const history: { gen: number; bestMs: number }[] = [];
  let historyOffset = 0;

  while (remainingTargetPlanes.length > 0) {
    const { candidates, planesWithCandidates } = buildFailureCandidates(
      remainingTargetPlanes,
      enabledRules,
      currentSchedule,
      currentTasks,
      failureEvents.length + 1,
    );
    candidateFailures.push(...candidates);
    remainingTargetPlanes = remainingTargetPlanes.filter(planeId => planesWithCandidates.has(planeId));

    const failureEvent = candidates.find(candidate => candidate.triggered) ?? null;
    if (!failureEvent) break;

    failureEvents.push(failureEvent);
    remainingTargetPlanes = remainingTargetPlanes.filter(planeId => planeId !== failureEvent.planeId);
    nextPlaneId += 1;

    const problem = buildRescheduleProblem(
      currentTasks,
      options.workflow,
      currentSchedule,
      failureEvent.planeId,
      failureEvent.end,
      nextPlaneId,
    );

    problem.frozenTaskIds.forEach(taskId => frozenTaskIds.add(taskId));
    problem.removedTaskIds.forEach(taskId => removedTaskIds.add(taskId));
    replacementPlaneIds.push(nextPlaneId);

    let runner: GeneticAlgorithm | SimulatedAnnealing;
    if (options.algorithm === 'GA') {
      runner = new GeneticAlgorithm(
        problem.rescheduleTasks,
        problem.rescheduleIds,
        options.resources,
        options.popSize,
        options.gens,
        options.sampleCount,
        problem.fixedSchedule,
        problem.releaseTimes,
      );
    } else {
      runner = new SimulatedAnnealing(
        problem.rescheduleTasks,
        problem.rescheduleIds,
        options.resources,
        options.gens,
        options.sampleCount,
        problem.fixedSchedule,
        problem.releaseTimes,
      );
    }

    const stageResult = await runner.run((gen, bestMs) => onProgress(historyOffset + gen, bestMs));
    stageResult.history.forEach(point => {
      history.push({ gen: point.gen + historyOffset, bestMs: point.bestMs });
    });
    historyOffset += options.gens;
    finalAverageMakespan = stageResult.makespan;
    currentSchedule = stageResult.scheduled;
    currentTasks = problem.rescheduleTasks;
  }

  const actualMakespan = calculateActualMakespan(currentSchedule);
  if (failureEvents.length === 0) {
    return {
      scheduled: currentSchedule,
      makespan: options.baseMakespan ?? actualMakespan,
      actualMakespan,
      tasks: currentTasks,
      history: [],
      triggered: false,
      failureEvent: null,
      failureEvents: [],
      candidateFailures,
      replacementPlaneIds: [],
      targetPlanes,
      frozenTaskIds: [],
      removedTaskIds: [],
    };
  }

  return {
    scheduled: currentSchedule,
    makespan: finalAverageMakespan,
    actualMakespan,
    tasks: currentTasks,
    history,
    triggered: true,
    failureEvent: failureEvents[0],
    failureEvents,
    candidateFailures,
    replacementPlaneId: replacementPlaneIds[0],
    replacementPlaneIds,
    targetPlanes,
    frozenTaskIds: Array.from(frozenTaskIds).sort(),
    removedTaskIds: Array.from(removedTaskIds).sort(),
  };
}
