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
) {
  const scheduled: Record<string, [number, number]> = {};
  const timeline: Record<string, number>[] = [];
  const priorityPositions = new Map(priority_list.map((taskId, index) => [taskId, index]));
  const effectiveDurations = durations ?? buildDurationMap(tasks, deterministicDuration);

  const getUsage = (time: number) => {
    while (timeline.length <= time) {
      const usage: Record<string, number> = {};
      for (const resource of Object.keys(res_cap)) usage[resource] = 0;
      timeline.push(usage);
    }
    return timeline[time];
  };

  const remainingTasks = [...priority_list];

  while (remainingTasks.length > 0) {
    const eligible = remainingTasks.filter(taskId => tasks[taskId].predecessors.every(pred => scheduled[pred] !== undefined));
    if (eligible.length === 0) break;

    let targetTaskId = eligible[0];
    let bestPosition = priorityPositions.get(targetTaskId) ?? Number.MAX_SAFE_INTEGER;
    for (const taskId of eligible) {
      const currentPosition = priorityPositions.get(taskId) ?? Number.MAX_SAFE_INTEGER;
      if (currentPosition < bestPosition) {
        targetTaskId = taskId;
        bestPosition = currentPosition;
      }
    }

    remainingTasks.splice(remainingTasks.indexOf(targetTaskId), 1);
    const task = tasks[targetTaskId];
    const taskDuration = effectiveDurations[targetTaskId];

    let est = 0;
    if (task.predecessors.length > 0) {
      est = Math.max(...task.predecessors.map(pred => scheduled[pred][1]));
    }

    let start_time = est;
    while (true) {
      let feasible = true;
      for (let t = start_time; t < start_time + taskDuration; t++) {
        const usage = getUsage(t);
        for (const [resource, amount] of Object.entries(task.resources)) {
          if ((usage[resource] ?? 0) + amount > (res_cap[resource] ?? 0)) {
            feasible = false;
            break;
          }
        }
        if (!feasible) break;
      }
      if (feasible) break;
      start_time++;
    }

    const end_time = start_time + taskDuration;
    scheduled[targetTaskId] = [start_time, end_time];
    for (let t = start_time; t < end_time; t++) {
      const usage = getUsage(t);
      for (const [resource, amount] of Object.entries(task.resources)) {
        usage[resource] = (usage[resource] ?? 0) + amount;
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

  constructor(tasks: Record<string, Task>, res_cap: ResourceMap, sampleCount = 100) {
    this.tasks = tasks;
    this.res_cap = res_cap;
    this.sampleCount = Math.max(1, sampleCount);
  }

  evaluate(priorityList: string[]) {
    let totalMakespan = 0;
    for (let i = 0; i < this.sampleCount; i++) {
      const durations = buildDurationMap(this.tasks, sampleDuration);
      totalMakespan += ssgs_decode(priorityList, this.tasks, this.res_cap, durations).makespan;
    }
    return Number((totalMakespan / this.sampleCount).toFixed(2));
  }

  deterministicSchedule(priorityList: string[]) {
    const durations = buildDurationMap(this.tasks, deterministicDuration);
    return ssgs_decode(priorityList, this.tasks, this.res_cap, durations);
  }
}

export class GeneticAlgorithm {
  tasks: Record<string, Task>;
  all_ids: string[];
  pop_size: number;
  gens: number;
  mutation_rate: number;
  evaluator: SequenceEvaluator;

  constructor(tasks: Record<string, Task>, all_ids: string[], res_cap: ResourceMap, pop_size = 30, gens = 50, sampleCount = 100) {
    this.tasks = tasks;
    this.all_ids = all_ids;
    this.pop_size = pop_size;
    this.gens = gens;
    this.mutation_rate = 0.2;
    this.evaluator = new SequenceEvaluator(tasks, res_cap, sampleCount);
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

  constructor(tasks: Record<string, Task>, all_ids: string[], res_cap: ResourceMap, gens = 100, sampleCount = 100) {
    this.tasks = tasks;
    this.all_ids = all_ids;
    this.gens = gens;
    this.evaluator = new SequenceEvaluator(tasks, res_cap, sampleCount);
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
