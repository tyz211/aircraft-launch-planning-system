export type ResourceMap = Record<string, number>;

export interface TaskInfo {
  id: string;
  name: string;
  duration: number;
  resources: ResourceMap;
  predecessors: string[];
}

export class Task {
  id: string;
  plane_id: number;
  type: string;
  name: string;
  duration: number;
  resources: ResourceMap;
  predecessors: string[];

  constructor(id: string, plane_id: number, type_code: string, name: string, duration: number, resources: ResourceMap, predecessors: string[]) {
    this.id = id;
    this.plane_id = plane_id;
    this.type = type_code;
    this.name = name;
    this.duration = duration;
    this.resources = resources;
    this.predecessors = predecessors;
  }
}

export function ssgs_decode(priority_list: string[], tasks: Record<string, Task>, res_cap: ResourceMap) {
  const scheduled: Record<string, [number, number]> = {};
  const timeline: Record<string, number>[] = Array.from({ length: 2000 }, () => {
    const obj: Record<string, number> = {};
    for (const k in res_cap) obj[k] = 0;
    return obj;
  });

  const remaining_tasks = [...priority_list];

  while (remaining_tasks.length > 0) {
    const eligible = remaining_tasks.filter(tid => {
      const task = tasks[tid];
      return task.predecessors.every(p => scheduled[p] !== undefined);
    });

    let target_tid: string | null = null;
    for (const tid of priority_list) {
      if (eligible.includes(tid)) {
        target_tid = tid;
        break;
      }
    }

    if (!target_tid) break;

    remaining_tasks.splice(remaining_tasks.indexOf(target_tid), 1);
    const task = tasks[target_tid];

    let est = 0;
    if (task.predecessors.length > 0) {
      est = Math.max(...task.predecessors.map(p => scheduled[p][1]));
    }

    let start_time = est;
    while (true) {
      let is_feasible = true;
      for (let t = start_time; t < start_time + task.duration; t++) {
        for (const [res, amount] of Object.entries(task.resources)) {
          if (timeline[t][res] + amount > res_cap[res]) {
            is_feasible = false;
            break;
          }
        }
        if (!is_feasible) break;
      }

      if (is_feasible) break;
      else start_time++;
    }

    const end_time = start_time + task.duration;
    scheduled[target_tid] = [start_time, end_time];
    for (let t = start_time; t < end_time; t++) {
      for (const [res, amount] of Object.entries(task.resources)) {
        timeline[t][res] += amount;
      }
    }
  }

  const makespan = Math.max(...Object.values(scheduled).map(v => v[1]));
  return { scheduled, makespan };
}

export class GeneticAlgorithm {
  tasks: Record<string, Task>;
  all_ids: string[];
  res_cap: ResourceMap;
  pop_size: number;
  gens: number;
  mutation_rate: number;

  constructor(tasks: Record<string, Task>, all_ids: string[], res_cap: ResourceMap, pop_size = 30, gens = 50) {
    this.tasks = tasks;
    this.all_ids = all_ids;
    this.res_cap = res_cap;
    this.pop_size = pop_size;
    this.gens = gens;
    this.mutation_rate = 0.2;
  }

  init_population() {
    const pop: string[][] = [];
    for (let i = 0; i < this.pop_size; i++) {
      const chrom = [...this.all_ids];
      for (let j = chrom.length - 1; j > 0; j--) {
        const k = Math.floor(Math.random() * (j + 1));
        [chrom[j], chrom[k]] = [chrom[k], chrom[j]];
      }
      pop.push(chrom);
    }
    return pop;
  }

  selection(pop: string[][], fitness: number[]) {
    const idx1 = Math.floor(Math.random() * pop.length);
    const idx2 = Math.floor(Math.random() * pop.length);
    return fitness[idx1] > fitness[idx2] ? pop[idx1] : pop[idx2];
  }

  crossover(p1: string[], p2: string[]) {
    const size = p1.length;
    let a = Math.floor(Math.random() * size);
    let b = Math.floor(Math.random() * size);
    if (a > b) [a, b] = [b, a];
    
    const child = new Array(size).fill(null);
    for (let i = a; i < b; i++) {
      child[i] = p1[i];
    }
    
    const p2_fill = p2.filter(item => !child.includes(item));
    let it = 0;
    for (let i = 0; i < size; i++) {
      if (child[i] === null) {
        child[i] = p2_fill[it++];
      }
    }
    return child;
  }

  mutate(chrom: string[]) {
    if (Math.random() < this.mutation_rate) {
      const idx1 = Math.floor(Math.random() * chrom.length);
      const idx2 = Math.floor(Math.random() * chrom.length);
      [chrom[idx1], chrom[idx2]] = [chrom[idx2], chrom[idx1]];
    }
    return chrom;
  }

  async run(onProgress: (gen: number, bestMs: number) => void) {
    let pop = this.init_population();
    let best_chrom: string[] | null = null;
    let min_makespan = Infinity;
    const history: { gen: number; bestMs: number }[] = [];

    for (let g = 0; g < this.gens; g++) {
      const results = pop.map(ind => ssgs_decode(ind, this.tasks, this.res_cap));
      const makespans = results.map(r => r.makespan);
      const fitness = makespans.map(m => 1.0 / m);

      const current_min = Math.min(...makespans);
      if (current_min < min_makespan) {
        min_makespan = current_min;
        best_chrom = [...pop[makespans.indexOf(current_min)]];
      }

      history.push({ gen: g + 1, bestMs: min_makespan });

      const new_pop = [best_chrom!];
      while (new_pop.length < this.pop_size) {
        const p1 = this.selection(pop, fitness);
        const p2 = this.selection(pop, fitness);
        let child = this.crossover(p1, p2);
        child = this.mutate(child);
        new_pop.push(child);
      }
      pop = new_pop;

      if (g % 5 === 0 || g === this.gens - 1) {
        onProgress(g + 1, min_makespan);
        // Yield to the event loop so the UI updates
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const { scheduled, makespan } = ssgs_decode(best_chrom!, this.tasks, this.res_cap);
    return { scheduled, makespan, history };
  }
}

export class GreedyAlgorithm {
  tasks: Record<string, Task>;
  all_ids: string[];
  res_cap: ResourceMap;

  constructor(tasks: Record<string, Task>, all_ids: string[], res_cap: ResourceMap) {
    this.tasks = tasks;
    this.all_ids = all_ids;
    this.res_cap = res_cap;
  }

  async run(onProgress: (gen: number, bestMs: number) => void) {
    // Greedy: sort by plane ID, then task type (F1 to F8) to simulate sequential processing
    const priority_list = [...this.all_ids].sort((a, b) => {
      const taskA = this.tasks[a];
      const taskB = this.tasks[b];
      if (taskA.plane_id !== taskB.plane_id) return taskA.plane_id - taskB.plane_id;
      return taskA.type.localeCompare(taskB.type);
    });

    const { scheduled, makespan } = ssgs_decode(priority_list, this.tasks, this.res_cap);
    
    // Simulate a single step for progress
    onProgress(1, makespan);
    await new Promise(r => setTimeout(r, 100));

    return { scheduled, makespan, history: [{ gen: 1, bestMs: makespan }] };
  }
}

export class SimulatedAnnealing {
  tasks: Record<string, Task>;
  all_ids: string[];
  res_cap: ResourceMap;
  gens: number;

  constructor(tasks: Record<string, Task>, all_ids: string[], res_cap: ResourceMap, gens = 100) {
    this.tasks = tasks;
    this.all_ids = all_ids;
    this.res_cap = res_cap;
    this.gens = gens;
  }

  async run(onProgress: (gen: number, bestMs: number) => void) {
    let current_chrom = [...this.all_ids].sort(() => Math.random() - 0.5);
    let { makespan: current_ms } = ssgs_decode(current_chrom, this.tasks, this.res_cap);
    
    let best_chrom = [...current_chrom];
    let best_ms = current_ms;
    
    let temp = 100;
    const cooling_rate = 0.95;
    const history: { gen: number; bestMs: number }[] = [];

    for (let g = 0; g < this.gens; g++) {
      // Generate neighbor by swapping two random tasks
      const neighbor = [...current_chrom];
      const idx1 = Math.floor(Math.random() * neighbor.length);
      const idx2 = Math.floor(Math.random() * neighbor.length);
      [neighbor[idx1], neighbor[idx2]] = [neighbor[idx2], neighbor[idx1]];

      const { makespan: neighbor_ms } = ssgs_decode(neighbor, this.tasks, this.res_cap);

      // Acceptance criteria
      if (neighbor_ms < current_ms || Math.random() < Math.exp((current_ms - neighbor_ms) / temp)) {
        current_chrom = neighbor;
        current_ms = neighbor_ms;
        if (current_ms < best_ms) {
          best_ms = current_ms;
          best_chrom = [...current_chrom];
        }
      }
      
      temp *= cooling_rate;
      history.push({ gen: g + 1, bestMs: best_ms });

      if (g % 5 === 0 || g === this.gens - 1) {
        onProgress(g + 1, best_ms);
        await new Promise(r => setTimeout(r, 0));
      }
    }

    const { scheduled, makespan } = ssgs_decode(best_chrom, this.tasks, this.res_cap);
    return { scheduled, makespan, history };
  }
}
